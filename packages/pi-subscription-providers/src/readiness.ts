import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getModels } from '@earendil-works/pi-ai/compat'

import { loadConfig, providerConfig, STATUS_PATH } from './config.ts'
import { resolveAntigravityCommand, resolveCursorCommand, which } from './detect.ts'
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

export function parseOpenCodeModels(stdout: string): DiscoveredModel[] {
	return stdout.split(/\r?\n/).flatMap((line) => {
		const id = line.trim()
		if (!id || (!id.startsWith('opencode/') && !id.endsWith('-free'))) return []
		return [{ id, name: id.split('/').pop() ?? id, reasoning: /reason|thinking/i.test(id) }]
	})
}

export async function checkOpenCodeReadiness(
	config: RootConfig = loadConfig(),
	runner: Runner = defaultRunner
): Promise<Readiness> {
	const cfg = providerConfig(config, 'opencode')
	if (!cfg.enabled)
		return emptyReadiness('opencode', 'disabled in subscription-providers.json', cfg)
	const command = cfg.command === 'auto' ? which('opencode') : which(cfg.command)
	if (!command) return emptyReadiness('opencode', 'opencode CLI not found on PATH', cfg)
	const result = await runner({
		command,
		args: ['models'],
		timeoutMs: Math.min(cfg.timeoutMs, 30_000),
		maxOutputChars: 50_000
	})
	const models = result.code === 0 ? parseOpenCodeModels(result.stdout) : []
	if (!models.length)
		return {
			...emptyReadiness(
				'opencode',
				`model discovery failed (${diagnostic(result.stderr) || 'no free models'})`,
				cfg
			),
			command
		}
	return {
		...emptyReadiness('opencode', `ready (${models.length} free models)`, cfg),
		ready: true,
		command,
		quotaAvailable: true,
		models
	}
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

/** Aliases, used only if Pi's Anthropic catalog is unavailable. */
const CLAUDE_CODE_ALIASES: DiscoveredModel[] = [
	{ id: 'sonnet', name: 'Claude Sonnet (Claude Code)', reasoning: true },
	{ id: 'opus', name: 'Claude Opus (Claude Code)', reasoning: true },
	{ id: 'haiku', name: 'Claude Haiku (Claude Code)', reasoning: false }
]

/** Version tuple from an id: "claude-opus-5-5" → [5, 5], "claude-haiku-4-5" → [4, 5]. */
function versionOf(id: string): number[] {
	return (id.match(/\d+/g) ?? []).map(Number)
}

function newerFirst(x: DiscoveredModel, y: DiscoveredModel): number {
	const a = versionOf(x.id)
	const b = versionOf(y.id)
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (b[i] ?? 0) - (a[i] ?? 0)
		if (d !== 0) return d
	}
	return x.id.localeCompare(y.id)
}

/**
 * Claude Code takes the same model ids as Anthropic's API, so mirror Pi's Anthropic catalog
 * (it tracks Pi upgrades). Dated snapshots duplicate their undated ids and are skipped.
 */
export function claudeCodeModels(): DiscoveredModel[] {
	let catalog: Array<{
		id: string
		name: string
		reasoning: boolean
		contextWindow: number
		maxTokens: number
	}> = []
	try {
		catalog = getModels('anthropic')
	} catch {
		// Catalog unavailable: fall back to Claude Code's aliases.
	}
	const models = catalog
		.filter((m) => !/-\d{8}$/.test(m.id))
		.map((m) => ({
			id: m.id,
			name: `${m.name.replace(/\s*\(latest\)$/, '')} (Claude Code)`,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens
		}))
		.toSorted(newerFirst)
	return models.length ? models : CLAUDE_CODE_ALIASES
}

export const CLAUDE_CODE_MODELS: DiscoveredModel[] = claudeCodeModels()

/** Newest Claude Code model of a tier ("sonnet", "opus", "haiku"). */
export function newestClaudeCode(tier: string): string | undefined {
	return CLAUDE_CODE_MODELS.find((m) => m.id === tier || m.id.includes(`-${tier}-`))?.id
}

/**
 * Claude Code CLI: uses the machine's existing Claude Code login. Anthropic rejects direct
 * third-party API calls on subscription plans, so requests must go through `claude -p`.
 */
export async function checkClaudeCodeReadiness(
	config: RootConfig = loadConfig(),
	runner: Runner = defaultRunner
): Promise<Readiness> {
	const cfg = providerConfig(config, 'claude-code')
	if (!cfg.enabled) {
		return emptyReadiness('claude-code', 'disabled in subscription-providers.json', cfg)
	}
	const command = cfg.command === 'auto' ? which('claude') : which(cfg.command)
	if (!command) return emptyReadiness('claude-code', 'claude CLI not found on PATH', cfg)
	const status = await runner({
		command,
		args: ['auth', 'status', '--json'],
		timeoutMs: 20_000,
		maxOutputChars: 20_000
	})
	let loggedIn = false
	try {
		loggedIn = (JSON.parse(status.stdout) as { loggedIn?: boolean }).loggedIn === true
	} catch {
		// Non-JSON output means not usable.
	}
	if (status.code !== 0 || !loggedIn) {
		return {
			...emptyReadiness('claude-code', 'not logged in (run `claude` and /login)', cfg),
			command
		}
	}
	return {
		provider: 'claude-code',
		ready: true,
		reason: `ready via claude -p (${CLAUDE_CODE_MODELS.length} models)`,
		command,
		billingMode: 'subscription',
		quotaAvailable: true,
		latencyEstimateMs: cfg.latencyEstimateMs,
		marginalInputCost: cfg.marginalInputCost,
		marginalOutputCost: cfg.marginalOutputCost,
		models: CLAUDE_CODE_MODELS,
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
	const claudeTtl = providerConfig(config, 'claude-code').readinessTtlMs
	const claudeCached = existing?.['claude-code']
	const claudePromise =
		!options.force && claudeCached && now - claudeCached.checkedAt < claudeTtl
			? Promise.resolve(claudeCached)
			: checkClaudeCodeReadiness(config, runner)
	const opencodeTtl = providerConfig(config, 'opencode').readinessTtlMs
	const opencodeCached = existing?.opencode
	const opencodePromise =
		!options.force && opencodeCached && now - opencodeCached.checkedAt < opencodeTtl
			? Promise.resolve(opencodeCached)
			: checkOpenCodeReadiness(config, runner)
	const [cursorFresh, antigravityFresh, claudeFresh, opencodeFresh] = await Promise.all([
		cursorPromise,
		antigravityPromise,
		claudePromise,
		opencodePromise
	])

	const snapshot: StatusSnapshot = {
		updatedAt: now,
		cursor: cursorFresh,
		antigravity: antigravityFresh,
		'claude-code': claudeFresh,
		opencode: opencodeFresh
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
		// Temp file + rename: JEV and ember-ui read this file while it is rewritten.
		const tmp = `${path}.${process.pid}.tmp`
		writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
		renameSync(tmp, path)
	} catch {
		// Status persistence must never break startup.
	}
}

/** Compact summaries for JEV (no secrets, no large catalogs). */
export function compactSummaries(snapshot: StatusSnapshot): {
	cursor: string
	antigravity: string
	'claude-code': string
	opencode: string
} {
	const fmt = (r: Readiness) =>
		r.ready
			? `${r.provider}: ready; billing=${r.billingMode}; models=${r.models.length}; latency~${r.latencyEstimateMs}ms; marginal=$${r.marginalInputCost}/$${r.marginalOutputCost} per MTok; tools=${r.toolMode}`
			: `${r.provider}: unavailable; ${r.reason}`
	const claude = snapshot['claude-code']
	const opencode = snapshot.opencode
	return {
		cursor: fmt(snapshot.cursor),
		antigravity: fmt(snapshot.antigravity),
		'claude-code': claude ? fmt(claude) : 'claude-code: unavailable; not checked yet',
		opencode: opencode ? fmt(opencode) : 'opencode: unavailable; not checked yet'
	}
}
