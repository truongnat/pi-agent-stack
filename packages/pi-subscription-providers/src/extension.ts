/**
 * Pi extension: register Cursor and Antigravity subscription providers.
 *
 * Authentication is delegated to the official CLIs. This extension never reads
 * cookies, auth.json, or OAuth token files. Models appear only when readiness
 * is confirmed. Both providers run in documented compatibility mode: assistant
 * text/thinking/usage stream through Pi; native Pi tool-call wire is not claimed.
 *
 * Startup is cache-first and non-blocking so missing CLIs never stall Pi.
 * Background readiness refresh re-publishes provider model lists into the live registry.
 *
 * Important: Pi calls refreshModels after every registerProvider with
 * allowNetwork=false. That path must return the in-memory snapshot only — never
 * probe CLIs or call publishProviders again (that caused a refresh cascade).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderModelConfig
} from '@earendil-works/pi-coding-agent'

import { loadConfig } from './config.ts'
import { which } from './detect.ts'
import { toProviderModels } from './models.ts'
import {
	CLAUDE_CODE_MODELS,
	compactSummaries,
	readStatus,
	refreshStatus,
	writeStatus
} from './readiness.ts'
import { streamAntigravityCli, streamClaudeCodeCli, streamCursorCli } from './stream.ts'
import type { ProviderId, Readiness, RootConfig, StatusSnapshot } from './types.ts'
import {
	formatStatusLine,
	getQuota,
	hasStatus,
	quotaExhausted,
	renderReport,
	USAGE_PROVIDERS,
	type ReportRow,
	type UsageDeps
} from './usage.ts'

const CURSOR_API = 'cursor-cli-compat'
const ANTIGRAVITY_API = 'antigravity-cli-compat'
const CLAUDE_CODE_API = 'claude-code-cli-compat'

const CLI_PROVIDERS = ['cursor', 'antigravity', 'claude-code'] as const

function autoPersistDefault(patch: Record<string, unknown>): void {
	const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json')
	try {
		let current: Record<string, unknown> = {}
		if (existsSync(settingsPath)) {
			current = JSON.parse(readFileSync(settingsPath, 'utf8'))
		}
		const updated = { ...current, ...patch }
		writeFileSync(settingsPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
	} catch {
		// ignore
	}
}

let snapshot: StatusSnapshot | null = null

function unavailable(provider: ProviderId, reason: string): Readiness {
	return {
		provider,
		ready: false,
		reason,
		billingMode: 'subscription',
		latencyEstimateMs: 0,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [],
		checkedAt: 0,
		toolMode: 'compatibility'
	}
}

function readinessOrUnavailable(provider: ProviderId, current: StatusSnapshot | null): Readiness {
	return current?.[provider] ?? unavailable(provider, 'provider_not_ready')
}

/**
 * Live plan quota for CLI providers, merged into every status write so JEV skips a
 * provider whose pools are all spent instead of paying for a failing request.
 */
const quotaOk: Partial<Record<ProviderId, boolean>> = {}

function persist(snap: StatusSnapshot): StatusSnapshot {
	let next = snap
	for (const p of CLI_PROVIDERS) {
		const ok = quotaOk[p]
		const row = next[p]
		if (ok !== undefined && row) next = { ...next, [p]: { ...row, quotaAvailable: ok } }
	}
	writeStatus(next)
	return next
}

/**
 * Claude Code's model aliases are static, so with `claude` on PATH its models can be listed
 * before the first readiness probe (otherwise `--model claude-code/…` fails at startup).
 * The background probe confirms the login and withdraws the models if it is missing.
 */
function provisionalClaudeCode(): Readiness {
	const command = which('claude')
	if (!command) return unavailable('claude-code', 'claude CLI not found on PATH')
	return {
		...unavailable('claude-code', 'pending login check'),
		ready: true,
		command,
		models: CLAUDE_CODE_MODELS
	}
}

function initialSnapshot(): StatusSnapshot {
	const cached = readStatus()
	if (cached) {
		for (const p of CLI_PROVIDERS) {
			if (cached[p]?.quotaAvailable === false) quotaOk[p] = false
		}
		return { ...cached, 'claude-code': cached['claude-code'] ?? provisionalClaudeCode() }
	}
	return {
		updatedAt: Date.now(),
		cursor: unavailable('cursor', 'pending readiness check'),
		antigravity: unavailable('antigravity', 'pending readiness check'),
		'claude-code': provisionalClaudeCode()
	}
}

/** Snapshot-only catalog used by offline Pi refreshes after registerProvider. */
export function modelsFromSnapshot(
	provider: ProviderId,
	snap: StatusSnapshot | null
): ProviderModelConfig[] {
	return toProviderModels(provider, readinessOrUnavailable(provider, snap))
}

/**
 * refreshModels contract:
 * - allowNetwork=false (Pi post-register refresh): return current snapshot, no CLI.
 * - allowNetwork=true: probe (TTL unless force), update snapshot, return models.
 * Never calls publishProviders — returning the list is how Pi updates the catalog.
 */
export async function refreshProviderModels(
	provider: ProviderId,
	context: { allowNetwork?: boolean; force?: boolean; signal?: AbortSignal },
	config: RootConfig = loadConfig()
): Promise<ProviderModelConfig[]> {
	if (context.signal?.aborted) throw new Error('aborted')
	if (!context.allowNetwork) {
		return modelsFromSnapshot(provider, snapshot)
	}
	const next = await refreshStatus(config, undefined, {
		force: context.force === true
	})
	if (context.signal?.aborted) throw new Error('aborted')
	snapshot = persist(next)
	return modelsFromSnapshot(provider, snapshot)
}

/** Last model list registered per provider. */
const published = new Map<ProviderId, string>()

/**
 * Re-registering a provider briefly resets its auth in Pi; doing it while a prompt starts
 * fails that prompt with "No API key found". Only re-register when the model list changed.
 */
function modelsChanged(provider: ProviderId, snap: StatusSnapshot): boolean {
	const key = JSON.stringify(modelsFromSnapshot(provider, snap))
	if (published.get(provider) === key) return false
	published.set(provider, key)
	return true
}

function publishProviders(pi: ExtensionAPI, snap: StatusSnapshot): void {
	snapshot = snap
	if (modelsChanged('cursor', snap))
		pi.registerProvider('cursor', {
			name: 'Cursor (CLI subscription)',
			baseUrl: 'cli://cursor-agent',
			apiKey: 'subscription-cli',
			api: CURSOR_API,
			models: modelsFromSnapshot('cursor', snap),
			refreshModels: (context) => refreshProviderModels('cursor', context),
			streamSimple: (model, context, options) =>
				streamCursorCli(model, context, options, readinessOrUnavailable('cursor', snapshot))
		})

	if (modelsChanged('antigravity', snap))
		pi.registerProvider('antigravity', {
			name: 'Google Antigravity (CLI subscription)',
			baseUrl: 'cli://agy',
			apiKey: 'subscription-cli',
			api: ANTIGRAVITY_API,
			models: modelsFromSnapshot('antigravity', snap),
			refreshModels: (context) => refreshProviderModels('antigravity', context),
			streamSimple: (model, context, options) =>
				streamAntigravityCli(
					model,
					context,
					options,
					readinessOrUnavailable('antigravity', snapshot)
				)
		})

	if (modelsChanged('claude-code', snap))
		pi.registerProvider('claude-code', {
			name: 'Claude Code (CLI subscription)',
			baseUrl: 'cli://claude',
			apiKey: 'subscription-cli',
			api: CLAUDE_CODE_API,
			models: modelsFromSnapshot('claude-code', snap),
			refreshModels: (context) => refreshProviderModels('claude-code', context),
			streamSimple: (model, context, options) =>
				streamClaudeCodeCli(
					model,
					context,
					options,
					readinessOrUnavailable('claude-code', snapshot)
				)
		})
}

function applyStatusUi(
	ctx: { hasUI: boolean; ui: { setStatus: (id: string, text: string) => void } },
	snap: StatusSnapshot
): void {
	if (!ctx.hasUI) return
	const summaries = compactSummaries(snap)
	const parts = [summaries.cursor, summaries.antigravity, summaries['claude-code']].filter(
		(line) => !line.includes('disabled')
	)
	ctx.ui.setStatus('subscription-providers', parts.map((line) => line.split(';')[0]).join(' · '))
}

type UsageCtx = Pick<
	ExtensionContext,
	'hasUI' | 'ui' | 'model' | 'modelRegistry' | 'sessionManager'
>

const USAGE_STATUS = 'usage-footer'
const USAGE_ENTRY = 'usage-report'

let usageProvider: string | undefined

function usageDeps(ctx: UsageCtx): UsageDeps {
	return {
		getApiKeyForProvider: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
		authSource: async (provider) => (await ctx.modelRegistry.getProviderAuth(provider))?.source,
		cliCommand: (provider) => (isCliProvider(provider) ? readyCommand(provider) : undefined)
	}
}

function isCliProvider(provider: string): provider is ProviderId {
	return (CLI_PROVIDERS as readonly string[]).includes(provider)
}

function readyCommand(provider: ProviderId): string | undefined {
	const r = snapshot?.[provider]
	return r?.ready ? r.command : undefined
}

/** Re-read CLI providers' quota (cached, no model call) and publish it for JEV. */
async function refreshSubscriptionQuota(ctx: UsageCtx): Promise<void> {
	const deps = usageDeps(ctx)
	let changed = false
	for (const p of CLI_PROVIDERS) {
		if (p === 'claude-code' && !readyCommand(p)) continue
		const quota = (await getQuota(p, deps))?.quota
		if (!quota) continue
		const ok = !quotaExhausted(quota)
		if (quotaOk[p] !== ok) changed = true
		quotaOk[p] = ok
	}
	if (changed && snapshot) snapshot = persist(snapshot)
}

/** Show the active provider's quota/account next to the input box. */
async function refreshUsageStatus(
	ctx: UsageCtx,
	provider: string | undefined = ctx.model?.provider
): Promise<void> {
	if (!ctx.hasUI) return
	usageProvider = provider
	const result = provider ? await getQuota(provider, usageDeps(ctx)) : undefined
	// Model may have changed while the fetch was in flight.
	if (usageProvider !== provider) return
	if (!provider || !hasStatus(result?.quota)) {
		ctx.ui.setStatus(USAGE_STATUS, undefined)
		return
	}
	ctx.ui.setStatus(USAGE_STATUS, formatStatusLine(provider, result.quota, ctx.ui.theme))
}

type UsageEntry = { rows: ReportRow[]; now: number }

/** Minimal TUI component: fixed lines, dropping color only when a line would overflow. */
function linesComponent(lines: string[]) {
	return {
		render: (width: number) =>
			lines.map((line) => {
				const padded = ` ${line}`
				const plain = stripVTControlCharacters(padded)
				return plain.length > width ? plain.slice(0, Math.max(0, width)) : padded
			}),
		invalidate: () => {}
	}
}

/** Every provider installed and signed in on this machine, in display order. */
async function usageRows(ctx: UsageCtx, force: boolean): Promise<ReportRow[]> {
	const active = ctx.model?.provider
	const deps = usageDeps(ctx)
	const rows = await Promise.all(
		USAGE_PROVIDERS.map(async (provider) => ({
			provider,
			active: provider === (active === 'claude-code' ? 'anthropic' : active),
			result: await getQuota(provider, deps, force)
		}))
	)
	// Fetchers return no quota for tools that are missing or logged out; hide those rows.
	return rows.filter((r) => r.result?.quota || r.result?.error)
}

/** Claude Code alias for an Anthropic model id: same tier, newest model. */
export function claudeCodeTier(modelId: string): 'opus' | 'sonnet' | 'haiku' {
	if (/opus/i.test(modelId)) return 'opus'
	if (/haiku/i.test(modelId)) return 'haiku'
	return 'sonnet'
}

/**
 * Anthropic subscription (OAuth) calls from Pi are rejected as third-party, and a missing
 * login fails outright. When Claude Code is logged in, move such a selection to the same
 * tier on `claude-code/*`; a real API key keeps the native provider.
 */
async function redirectAnthropic(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, 'hasUI' | 'ui' | 'model' | 'modelRegistry'>,
	model = ctx.model
): Promise<void> {
	if (model?.provider !== 'anthropic' || !readyCommand('claude-code')) return
	const auth = ctx.modelRegistry.getProviderAuthStatus('anthropic')
	if (auth.configured && !ctx.modelRegistry.isUsingOAuth(model)) return
	const target = ctx.modelRegistry.find('claude-code', claudeCodeTier(model.id))
	if (!target || !(await pi.setModel(target))) return
	if (ctx.hasUI) {
		ctx.ui.notify(
			`anthropic/${model.id} → claude-code/${target.id}: using the machine's Claude Code login (Anthropic blocks subscription calls from third-party apps).`,
			'info'
		)
	}
}

export default function (pi: ExtensionAPI): void {
	const config: RootConfig = loadConfig()
	snapshot = initialSnapshot()
	publishProviders(pi, snapshot)

	pi.on('session_start', (_event, ctx) => {
		void redirectAnthropic(pi, ctx).catch(() => {})
		void refreshUsageStatus(ctx).catch(() => {})
		// Probe once in the background, then publish that snapshot.
		// registerProvider triggers an offline refreshModels pass that must not re-probe.
		void refreshStatus(config)
			.then(async (next) => {
				const snap = persist(next)
				publishProviders(pi, snap)
				applyStatusUi(ctx, snap)
				await refreshSubscriptionQuota(ctx)
			})
			.catch(() => {
				// Readiness refresh must never break session start.
			})
	})

	pi.registerCommand('subscription-providers', {
		description: 'subscription-providers: status | refresh',
		handler: async (args, ctx) => {
			const cmd = (args ?? '').trim()
			if (cmd === 'refresh') {
				snapshot = await refreshStatus(config, undefined, { force: true })
			} else {
				snapshot = snapshot ?? (await refreshStatus(config))
			}
			snapshot = persist(snapshot)
			publishProviders(pi, snapshot)
			const summaries = compactSummaries(snapshot)
			ctx.ui.notify(`${summaries.cursor}\n${summaries.antigravity}`, 'info')
		}
	})

	pi.on('agent_end', (_event, ctx) => {
		void refreshUsageStatus(ctx).catch(() => {})
		void refreshSubscriptionQuota(ctx).catch(() => {})
	})

	pi.registerCommand('usage', {
		description:
			'Plan quota, balance, and account for every detected provider (refresh: bypass cache)',
		handler: async (args, ctx) => {
			const force = (args ?? '').trim() === 'refresh'
			const entry: UsageEntry = { rows: await usageRows(ctx, force), now: Date.now() }
			await refreshSubscriptionQuota(ctx)
			if (ctx.hasUI) {
				// Custom entries render in the transcript but never enter model context.
				pi.appendEntry(USAGE_ENTRY, entry)
			} else {
				ctx.ui.notify(renderReport(entry.rows, undefined, entry.now).join('\n'), 'info')
			}
			await refreshUsageStatus(ctx)
		}
	})

	pi.registerEntryRenderer<UsageEntry>(USAGE_ENTRY, (entry, _options, theme) =>
		entry.data ? linesComponent(renderReport(entry.data.rows, theme, entry.data.now)) : undefined
	)

	pi.on('model_select', (event, ctx) => {
		void redirectAnthropic(pi, ctx, event.model).catch(() => {})
		void refreshUsageStatus(ctx, event.model?.provider).catch(() => {})
		if (event.source === 'restore') return
		if (event.model?.provider && event.model?.id) {
			autoPersistDefault({
				defaultProvider: event.model.provider,
				defaultModel: event.model.id
			})
		}
	})

	pi.on('thinking_level_select', (event) => {
		if (event.level) {
			autoPersistDefault({
				defaultThinkingLevel: event.level
			})
		}
	})
}
