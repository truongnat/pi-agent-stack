import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { loadConfig, providerConfig, STATUS_PATH } from './config.ts'
import { resolveAntigravityCommand, resolveCursorCommand } from './detect.ts'
import { diagnostic } from './redact.ts'
import { defaultRunner } from './subprocess.ts'
import type { DiscoveredModel, Readiness, RootConfig, Runner, StatusSnapshot } from './types.ts'

function emptyReadiness(
	provider: Readiness['provider'],
	reason: string,
	cfg: ReturnType<typeof providerConfig>
): Readiness {
	return {
		provider,
		ready: false,
		reason,
		billingMode: 'subscription',
		latencyEstimateMs: cfg.latencyEstimateMs,
		marginalInputCost: cfg.marginalInputCost,
		marginalOutputCost: cfg.marginalOutputCost,
		models: [],
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
}

function parseCursorModels(stdout: string): DiscoveredModel[] {
	const models: DiscoveredModel[] = []
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9._[\]=-]+)\s+-\s+(.+)$/.exec(line.trim())
		if (!match) continue
		const id = match[1] ?? ''
		const name = match[2] ?? id
		if (!id || id.toLowerCase() === 'available models') continue
		models.push({
			id,
			name,
			reasoning: /thinking|high|xhigh|reason/i.test(name) || /thinking|reason/i.test(id)
		})
	}
	return models
}

function parseAgyModels(stdout: string): DiscoveredModel[] {
	const models: DiscoveredModel[] = []
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9._-]+)\t(.+)$/.exec(line.trim())
		if (!match) continue
		const id = match[1] ?? ''
		const name = match[2] ?? id
		models.push({
			id,
			name,
			reasoning: /thinking|high|pro|reason/i.test(name) || /thinking|reason/i.test(id)
		})
	}
	return models
}

export async function checkCursorReadiness(
	config: RootConfig = loadConfig(),
	runner: Runner = defaultRunner
): Promise<Readiness> {
	const cfg = providerConfig(config, 'cursor')
	if (!cfg.enabled) return emptyReadiness('cursor', 'disabled in subscription-providers.json', cfg)

	const resolved = await resolveCursorCommand(cfg.command, runner)
	if (!resolved.command) return emptyReadiness('cursor', resolved.reason, cfg)

	const status = await runner({
		command: resolved.command,
		args: ['status'],
		timeoutMs: Math.min(cfg.timeoutMs, 20_000),
		maxOutputChars: 4_000
	})
	const statusText = `${status.stdout}\n${status.stderr}`.toLowerCase()
	const authenticated =
		status.code === 0 &&
		(statusText.includes('logged in') ||
			statusText.includes('authenticated') ||
			statusText.includes('✓'))
	if (!authenticated) {
		return {
			...emptyReadiness(
				'cursor',
				`unauthenticated (${diagnostic(status.stderr || status.stdout) || 'run cursor-agent login'})`,
				cfg
			),
			command: resolved.command
		}
	}

	const modelsResult = await runner({
		command: resolved.command,
		args: ['models'],
		timeoutMs: Math.min(cfg.timeoutMs, 30_000),
		maxOutputChars: 50_000
	})
	const models =
		modelsResult.code === 0 ? parseCursorModels(modelsResult.stdout) : ([] as DiscoveredModel[])
	if (!models.length) {
		return {
			...emptyReadiness(
				'cursor',
				`authenticated but model discovery failed (${diagnostic(modelsResult.stderr) || 'no models'})`,
				cfg
			),
			command: resolved.command
		}
	}

	return {
		provider: 'cursor',
		ready: true,
		reason: `ready (${models.length} models)`,
		command: resolved.command,
		billingMode: 'subscription',
		quotaAvailable: true,
		latencyEstimateMs: cfg.latencyEstimateMs,
		marginalInputCost: cfg.marginalInputCost,
		marginalOutputCost: cfg.marginalOutputCost,
		models,
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
}

export async function checkAntigravityReadiness(
	config: RootConfig = loadConfig(),
	runner: Runner = defaultRunner
): Promise<Readiness> {
	const cfg = providerConfig(config, 'antigravity')
	if (!cfg.enabled) {
		return emptyReadiness('antigravity', 'disabled in subscription-providers.json', cfg)
	}

	const resolved = await resolveAntigravityCommand(cfg.command, runner)
	if (!resolved.command || resolved.interface === 'none') {
		return emptyReadiness('antigravity', resolved.reason, cfg)
	}

	if (resolved.interface === 'acp') {
		// ACP binary may exist, but this package only streams via agy NDJSON today.
		return {
			...emptyReadiness(
				'antigravity',
				'ACP binary found but ACP stream adapter is not implemented; install/use agy for stream-json',
				cfg
			),
			command: resolved.command
		}
	}

	const modelsResult = await runner({
		command: resolved.command,
		args: ['models'],
		timeoutMs: Math.min(cfg.timeoutMs, 45_000),
		maxOutputChars: 50_000
	})
	if (modelsResult.code !== 0) {
		return {
			...emptyReadiness(
				'antigravity',
				`agy not ready (${diagnostic(modelsResult.stderr || modelsResult.stdout) || 'models failed'})`,
				cfg
			),
			command: resolved.command
		}
	}
	const models = parseAgyModels(modelsResult.stdout)
	if (!models.length) {
		return {
			...emptyReadiness('antigravity', 'agy returned no models (auth or catalog unavailable)', cfg),
			command: resolved.command
		}
	}

	return {
		provider: 'antigravity',
		ready: true,
		reason: `ready via agy stream-json (${models.length} models)`,
		command: resolved.command,
		billingMode: 'subscription',
		quotaAvailable: true,
		latencyEstimateMs: cfg.latencyEstimateMs,
		marginalInputCost: cfg.marginalInputCost,
		marginalOutputCost: cfg.marginalOutputCost,
		models,
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
}

export async function refreshStatus(
	config: RootConfig = loadConfig(),
	runner: Runner = defaultRunner,
	options: { force?: boolean } = {}
): Promise<StatusSnapshot> {
	const existing = readStatus()
	const now = Date.now()
	const cursorTtl = providerConfig(config, 'cursor').readinessTtlMs
	const agyTtl = providerConfig(config, 'antigravity').readinessTtlMs

	const cursorPromise =
		!options.force && existing && now - existing.cursor.checkedAt < cursorTtl
			? Promise.resolve(existing.cursor)
			: checkCursorReadiness(config, runner)
	const antigravityPromise =
		!options.force && existing && now - existing.antigravity.checkedAt < agyTtl
			? Promise.resolve(existing.antigravity)
			: checkAntigravityReadiness(config, runner)
	const [cursorFresh, antigravityFresh] = await Promise.all([cursorPromise, antigravityPromise])

	const snapshot: StatusSnapshot = {
		updatedAt: now,
		cursor: cursorFresh,
		antigravity: antigravityFresh
	}
	writeStatus(snapshot)
	return snapshot
}

export function readStatus(path = STATUS_PATH): StatusSnapshot | null {
	try {
		// SAFETY: local status cache written by this package; malformed → ignore.
		return JSON.parse(readFileSync(path, 'utf8')) as StatusSnapshot
	} catch {
		return null
	}
}

export function writeStatus(snapshot: StatusSnapshot, path = STATUS_PATH): void {
	try {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
	} catch {
		// Status persistence must never break startup.
	}
}

/** Compact summaries for JEV (no secrets, no large catalogs). */
export function compactSummaries(snapshot: StatusSnapshot): {
	cursor: string
	antigravity: string
} {
	const fmt = (r: Readiness) =>
		r.ready
			? `${r.provider}: ready; billing=${r.billingMode}; models=${r.models.length}; latency~${r.latencyEstimateMs}ms; marginal=$${r.marginalInputCost}/$${r.marginalOutputCost} per MTok; tools=${r.toolMode}`
			: `${r.provider}: unavailable; ${r.reason}`
	return { cursor: fmt(snapshot.cursor), antigravity: fmt(snapshot.antigravity) }
}
