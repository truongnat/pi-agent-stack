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
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderModelConfig
} from '@earendil-works/pi-coding-agent'

import {
	accessToken,
	accountPlan,
	blockActive,
	captureLive,
	chooseAccount,
	failedBeforeOutput,
	httpQuota,
	livePools,
	poolForProvider,
	readStore,
	rotationReason,
	updateStore,
	watchedFiles,
	writeLive,
	type Account,
	type AccountStore,
	type PoolId,
	type QuotaCheck
} from './accounts.ts'
import { CONFIG_PATH, loadConfig } from './config.ts'
import { which } from './detect.ts'
import { toProviderModels } from './models.ts'
import {
	CLAUDE_CODE_MODELS,
	compactSummaries,
	newestClaudeCode,
	readStatus,
	refreshStatus,
	writeStatus
} from './readiness.ts'
import { streamAntigravityCli, streamClaudeCodeCli, streamCursorCli } from './stream.ts'
import type { ProviderId, Readiness, RootConfig, StatusSnapshot } from './types.ts'
import {
	displayName,
	formatStatusLine,
	getQuota,
	hasStatus,
	quotaExhausted,
	renderReport,
	USAGE_PROVIDERS,
	type QuotaResult,
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
		const claude = cached['claude-code']
		// Cached lists may predate a catalog change (e.g. aliases → real ids); models are static.
		return {
			...cached,
			'claude-code': claude?.ready
				? { ...claude, models: CLAUDE_CODE_MODELS }
				: (claude ?? provisionalClaudeCode())
		}
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
	ctx: { hasUI: boolean; ui: { setStatus: (id: string, text: string | undefined) => void } },
	_snap: StatusSnapshot
): void {
	if (!ctx.hasUI) return
	// Keep status footer concise; full provider readiness is shown in /usage
	ctx.ui.setStatus('subscription-providers', undefined)
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
	// Pooled providers show the account Pi is actually using, not the CLI's own login.
	const pool = provider ? USAGE_POOL[provider] : undefined
	const entry = pool ? readStore()[pool] : undefined
	const activeAccount = entry?.active ? entry.accounts[entry.active] : undefined
	const count = entry ? Object.keys(entry.accounts).length : 0
	const found = pool && activeAccount ? await accountQuota(pool, activeAccount) : undefined
	// With several logins, show which one is in use: "me@x.com (2/3)".
	const index =
		entry && activeAccount ? Object.keys(entry.accounts).indexOf(activeAccount.key) + 1 : 0
	const pooled =
		found?.quota && count > 1
			? {
					...found,
					quota: { ...found.quota, account: `${found.quota.account} (${index}/${count})` }
				}
			: found
	const result =
		pooled?.quota?.windows.length || !provider ? pooled : await getQuota(provider, usageDeps(ctx))
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
/** Usage provider → the account pool whose accounts it should list. */
const USAGE_POOL: Record<string, PoolId> = {
	'openai-codex': 'pi:openai-codex',
	anthropic: 'claude-code',
	'claude-code': 'claude-code'
}

/** Quota of one saved account, read with that account's own token. */
async function accountQuota(pool: PoolId, account: Account): Promise<QuotaResult> {
	const base = { account: account.label, plan: accountPlan(pool, account.credential), windows: [] }
	const token = accessToken(pool, account)
	if (!token) return { quota: base, error: 'token expired; refreshed when this account is used' }
	const quota = await cachedQuota(pool, token).catch(() => undefined)
	return quota
		? { quota: { ...base, windows: quota.windows } }
		: { quota: base, error: 'quota unavailable' }
}

/** One row per saved account when a provider has several (active account marked). */
async function expandAccounts(rows: ReportRow[]): Promise<ReportRow[]> {
	const store = readStore()
	const out: ReportRow[] = []
	for (const row of rows) {
		const pool = USAGE_POOL[row.provider]
		const entry = pool ? store[pool] : undefined
		if (!pool || !entry || Object.keys(entry.accounts).length < 2) {
			out.push(row)
			continue
		}
		for (const account of Object.values(entry.accounts)) {
			out.push({
				provider: row.provider,
				active: account.key === entry.active,
				result: await accountQuota(pool, account)
			})
		}
	}
	return out
}

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
	await syncAccounts(undefined).catch(() => undefined)
	return expandAccounts(rows.filter((r) => r.result?.quota || r.result?.error))
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
/** A saved Claude Code alias ("opus") moves to the newest real model of that tier. */
async function upgradeClaudeAlias(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, 'model' | 'modelRegistry'>,
	model = ctx.model
): Promise<void> {
	if (model?.provider !== 'claude-code' || !['sonnet', 'opus', 'haiku'].includes(model.id)) return
	const id = newestClaudeCode(model.id)
	const target = id ? ctx.modelRegistry.find('claude-code', id) : undefined
	if (target) await pi.setModel(target)
}

async function redirectAnthropic(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, 'hasUI' | 'ui' | 'model' | 'modelRegistry'>,
	model = ctx.model
): Promise<void> {
	if (model?.provider !== 'anthropic' || !readyCommand('claude-code')) return
	const auth = ctx.modelRegistry.getProviderAuthStatus('anthropic')
	if (auth.configured && !ctx.modelRegistry.isUsingOAuth(model)) return
	const target =
		ctx.modelRegistry.find('claude-code', model.id) ??
		ctx.modelRegistry.find('claude-code', newestClaudeCode(claudeCodeTier(model.id)) ?? '')
	if (!target || !(await pi.setModel(target))) return
	if (ctx.hasUI) {
		ctx.ui.notify(
			`anthropic/${model.id} → claude-code/${target.id}: using the machine's Claude Code login (Anthropic blocks subscription calls from third-party apps).`,
			'info'
		)
	}
}

declare global {
	/** Set by pi-jev-harness while it changes model/thinking on its own. */
	var piAgentStackAutomaticChange: number | undefined
}

type NotifyCtx = Pick<ExtensionContext, 'hasUI' | 'ui'>

/** Save new logins into their pools and follow refreshed tokens of known ones. */
async function syncAccounts(ctx: NotifyCtx | undefined): Promise<AccountStore> {
	const added: Array<{ pool: PoolId; label: string; count: number }> = []
	const store = updateStore((current) => {
		let next = current
		for (const pool of livePools()) {
			const captured = captureLive(pool, next)
			next = captured.store
			const count = Object.keys(next[pool]?.accounts ?? {}).length
			const label = captured.key ? next[pool]?.accounts[captured.key]?.label : undefined
			if (captured.added && count > 1) added.push({ pool, label: label ?? 'new account', count })
		}
		return next
	})
	if (ctx?.hasUI) {
		for (const a of added) {
			ctx.ui.notify(
				`${a.pool}: saved ${a.label} (${a.count} accounts, rotates when one runs out)`,
				'info'
			)
		}
	}
	return store
}

const quotaCache = new Map<string, { at: number; quota: Awaited<ReturnType<QuotaCheck>> }>()
const cachedQuota: QuotaCheck = async (pool, token) => {
	const hit = quotaCache.get(token)
	if (hit && Date.now() - hit.at < 60_000) return hit.quota
	const quota = await httpQuota(pool, token)
	quotaCache.set(token, { at: Date.now(), quota })
	return quota
}

async function rotate(
	pool: PoolId,
	store: AccountStore,
	ctx: NotifyCtx,
	prefix: string
): Promise<Account | undefined> {
	const previous = store[pool]?.active ? store[pool]?.accounts[store[pool].active] : undefined
	const result = await chooseAccount(pool, store, cachedQuota)
	// Quota checks awaited the network; apply this pool's outcome to the latest store.
	updateStore((current) => {
		const entry = result.store[pool]
		return entry ? { ...current, [pool]: entry } : current
	})
	if (!result.switchTo) return undefined
	writeLive(pool, result.switchTo.credential)
	if (ctx.hasUI) {
		ctx.ui.notify(
			`${prefix}${pool}: ${previous?.label ?? 'account'} ${result.reason ?? 'unavailable'} → switched to ${result.switchTo.label}`,
			'warning'
		)
	}
	return result.switchTo
}

/** Pi provider id behind a pool. */
function providerOfPool(pool: PoolId): string {
	return pool.startsWith('pi:') ? pool.slice(3) : pool
}

/**
 * Balanced default per provider, used the first time the session lands on it: neither the
 * largest nor the smallest model. Overridable with `balancedModels` in
 * ~/.pi/agent/subscription-providers.json.
 */
const BALANCED_MODEL: Record<string, string> = {
	'openai-codex': 'gpt-6-luna',
	cursor: 'auto',
	xai: 'grok-4.6',
	'claude-code': newestClaudeCode('sonnet') ?? 'sonnet',
	anthropic: newestClaudeCode('sonnet') ?? 'claude-sonnet-5'
}

function balancedModel(provider: string): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
			balancedModels?: Record<string, string>
		}
		return raw.balancedModels?.[provider] ?? BALANCED_MODEL[provider]
	} catch {
		return BALANCED_MODEL[provider]
	}
}

type ProviderChoice = { model: string; thinking?: string | undefined }

/** Set while the account menu moves providers, so the harness's own resets are not remembered. */
let switchingProvider = false

/** Model and thinking level last chosen per provider, kept across sessions. */
const MEMORY_PATH = join(homedir(), '.pi', 'agent', 'provider-memory.json')

function readMemory(): Record<string, ProviderChoice> {
	try {
		return JSON.parse(readFileSync(MEMORY_PATH, 'utf8')) as Record<string, ProviderChoice>
	} catch {
		return {}
	}
}

function remember(provider: string, patch: Partial<ProviderChoice>): void {
	if (switchingProvider) return
	const memory = readMemory()
	const next = { ...memory[provider], ...patch } as ProviderChoice
	if (!next.model) return
	try {
		writeFileSync(MEMORY_PATH, `${JSON.stringify({ ...memory, [provider]: next }, null, 2)}\n`)
	} catch {
		// Memory is a convenience; a write failure only loses the preference.
	}
}

/** The model to land on for a pool: the user's last choice, else the balanced default. */
function modelForPool(ctx: Pick<ExtensionContext, 'modelRegistry'>, pool: PoolId) {
	const provider = providerOfPool(pool)
	// The auth-filtered list can lag a provider that just re-registered; fall back to all models.
	const ready = ctx.modelRegistry.getAvailable().filter((m) => m.provider === provider)
	const available = ready.length
		? ready
		: ctx.modelRegistry.getAll().filter((m) => m.provider === provider)
	const memory = readMemory()[provider]
	for (const id of [memory?.model, balancedModel(provider)]) {
		const model = id ? available.find((m) => m.id === id) : undefined
		if (model) return { model, thinking: id === memory?.model ? memory?.thinking : undefined }
	}
	return available[0] ? { model: available[0], thinking: undefined } : undefined
}

/** Human name of a pool: "pi:openai-codex" → "codex". */
function poolName(pool: PoolId): string {
	return displayName(pool.startsWith('pi:') ? pool.slice(3) : pool)
}

function formatAccounts(store: AccountStore, now = Date.now()): string {
	const lines: string[] = []
	for (const [pool, entry] of Object.entries(store)) {
		lines.push(poolName(pool as PoolId))
		Object.values(entry.accounts).forEach((a, i) => {
			const blocked =
				a.blockedUntil && a.blockedUntil > now
					? `  (${a.blockedReason ?? 'blocked'} until ${new Date(a.blockedUntil).toLocaleString()})`
					: ''
			lines.push(`  ${a.key === entry.active ? '●' : '○'} ${i + 1}. ${a.label}${blocked}`)
		})
	}
	return lines.length ? lines.join('\n') : 'No accounts saved yet. Log in with /login <provider>.'
}

export default function (pi: ExtensionAPI): void {
	const config: RootConfig = loadConfig()
	snapshot = initialSnapshot()
	publishProviders(pi, snapshot)

	let accountsCtx: NotifyCtx | undefined
	let syncTimer: NodeJS.Timeout | undefined
	const scheduleSync = () => {
		clearTimeout(syncTimer)
		syncTimer = setTimeout(() => void syncAccounts(accountsCtx).catch(() => {}), 800)
	}
	// Directory watches survive the atomic renames Pi and the CLIs use to rewrite credentials.
	for (const file of watchedFiles()) {
		try {
			const name = file.split('/').pop()
			watch(join(file, '..'), (_type, changed) => {
				if (changed === name) scheduleSync()
			}).unref()
		} catch {
			// Missing directory: that CLI is not installed.
		}
	}

	pi.on('before_agent_start', async (_event, ctx) => {
		accountsCtx = ctx
		const pool = poolForProvider(ctx.model?.provider, livePools())
		if (!pool) return
		const store = await syncAccounts(ctx).catch(() => undefined)
		if (store) await rotate(pool, store, ctx, '').catch(() => undefined)
	})

	pi.on('agent_end', async (event, ctx) => {
		const last = [...event.messages].toReversed().find((m) => m.role === 'assistant')
		if (last?.role !== 'assistant' || last.stopReason !== 'error') return
		// Pi's retry backoff (2s, 4s, 8s) has no jitter and awaits this handler first; a random
		// extra wait keeps several sessions from retrying one provider in lockstep.
		if (isRetryableAssistantError(last)) await sleep(Math.random() * 1000)
		const reason = rotationReason(last.errorMessage)
		const pool = reason ? poolForProvider(last.provider, livePools()) : undefined
		if (!reason || !pool) return
		const until = Date.now() + (reason === 'quota' ? 60 * 60_000 : 24 * 60 * 60_000)
		const store = updateStore((current) =>
			blockActive(pool, current, reason === 'quota' ? 'limit reached' : 'login failed', until)
		)
		// The request has failed and nothing runs, so the switch is safe now.
		const next = await rotate(pool, store, ctx, '').catch(() => undefined)
		if (!next) {
			if (ctx.hasUI && Object.keys(store[pool]?.accounts ?? {}).length > 1) {
				ctx.ui.notify(
					`${poolName(pool)}: every saved account is blocked or out of quota.`,
					'warning'
				)
			}
			return
		}
		// Pi retries transient errors itself (with backoff) and that retry now uses the new
		// account; resend the rest only when the failed reply showed nothing.
		if (isRetryableAssistantError(last) || !failedBeforeOutput(last)) return
		pi.sendMessage(
			{
				customType: 'account-switched',
				content: `The request failed on a ${poolName(pool)} account (${reason}); it now runs on another account. Continue the task.`,
				display: false
			},
			{ triggerTurn: true, deliverAs: 'followUp' }
		)
	})

	pi.registerCommand('accounts', {
		description: 'Pick the account in use from every saved login (only while nothing is running)',
		handler: async (_args, ctx) => {
			let store = await syncAccounts(ctx)
			if (!ctx.hasUI) {
				ctx.ui.notify(formatAccounts(store), 'info')
				return
			}
			const busy = () => {
				if (ctx.isIdle()) return false
				ctx.ui.notify(
					'Accounts switch only while idle: wait until the current request and tools finish.',
					'warning'
				)
				return true
			}
			if (busy()) return
			// One list of every saved account, grouped by provider; exactly one is in use: the
			// active account of the provider behind the current model.
			const inUsePool = poolForProvider(ctx.model?.provider, livePools())
			const pools = (Object.keys(store) as PoolId[])
				.filter((p) => Object.keys(store[p]?.accounts ?? {}).length)
				// Provider in use first; the rest keep their saved order.
				.toSorted((x, y) => Number(y === inUsePool) - Number(x === inUsePool))
			const rows = pools.flatMap((pool) =>
				Object.values(store[pool]?.accounts ?? {}).map((account) => ({ pool, account }))
			)
			if (rows.length === 0) {
				ctx.ui.notify('No accounts saved yet. Log in with /login <provider>.', 'info')
				return
			}
			const width = Math.max(...pools.map((p) => poolName(p).length))
			const now = Date.now()
			const lines = await Promise.all(
				rows.map(async ({ pool, account }) => {
					const quota = await accountQuota(pool, account)
					const inUse = pool === inUsePool && store[pool]?.active === account.key
					const plan = quota.quota?.plan ? `[${quota.quota.plan.toUpperCase()}]` : ''
					const usageBars = (quota.quota?.windows ?? [])
						.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`)
						.join('  ')
					const blocked =
						account.blockedUntil && account.blockedUntil > now
							? `(blocked: ${account.blockedReason ?? 'rate limit'})`
							: ''
					const statusTag = inUse ? '● active' : '○ switch'
					const details = [plan, usageBars, blocked].filter(Boolean).join('  ')
					return `${statusTag.padEnd(9)} │ ${poolName(pool).padEnd(width)} │ ${account.label}${details ? `  ${details}` : ''}`
				})
			)
			const REMOVE = '✕  Remove an account…'
			const picked = await ctx.ui.select('Accounts & Subscription Pool (Ember UX)', [
				...lines,
				REMOVE
			])
			if (!picked) return
			if (picked === REMOVE) {
				const removable = rows.filter(
					({ pool, account }) => !(pool === inUsePool && store[pool]?.active === account.key)
				)
				const labels = removable.map(
					({ pool, account }) => `${poolName(pool).padEnd(width)} │ ${account.label}`
				)
				const target = labels.length
					? await ctx.ui.select('Remove which account?', labels)
					: undefined
				const row = target ? removable[labels.indexOf(target)] : undefined
				if (!row) return
				if (
					!(await ctx.ui.confirm(
						'Remove account',
						`Forget ${row.account.label}? Log in again to add it back.`
					))
				)
					return
				const entry = store[row.pool]
				if (!entry) return
				store = updateStore((current) => {
					const pool = current[row.pool]
					if (!pool) return current
					const { [row.account.key]: _removed, ...rest } = pool.accounts
					return { ...current, [row.pool]: { ...pool, accounts: rest } }
				})
				ctx.ui.notify(`${poolName(row.pool)}: removed ${row.account.label}`, 'info')
				return
			}
			const row = rows[lines.indexOf(picked)]
			if (!row) return
			// The dialog may have stayed open while a request started.
			if (busy()) return
			const entry = store[row.pool]
			if (!entry) return
			if (entry.active !== row.account.key) {
				writeLive(row.pool, row.account.credential)
				store = updateStore((current) => {
					const pool = current[row.pool]
					return pool ? { ...current, [row.pool]: { ...pool, active: row.account.key } } : current
				})
			}
			// Another provider's account: move the session onto that provider too, keeping the
			// choice being left so coming back restores it.
			if (row.pool !== inUsePool) {
				if (ctx.model) {
					remember(ctx.model.provider, { model: ctx.model.id, thinking: pi.getThinkingLevel() })
				}
				// Read the target's saved choice before switching: setModel resets thinking.
				const choice = modelForPool(ctx, row.pool)
				switchingProvider = true
				let switched = false
				try {
					switched = choice ? await pi.setModel(choice.model) : false
					if (switched && choice?.thinking) {
						pi.setThinkingLevel(choice.thinking as ReturnType<typeof pi.getThinkingLevel>)
					}
				} finally {
					switchingProvider = false
				}
				if (!switched) {
					ctx.ui.notify(
						`${poolName(row.pool)} is set to ${row.account.label}, but no model of it is available.`,
						'warning'
					)
					return
				}
			}
			ctx.ui.notify(`Now using ${poolName(row.pool)} · ${row.account.label}`, 'info')
			await refreshUsageStatus(ctx).catch(() => {})
		}
	})

	pi.on('session_start', (_event, ctx) => {
		accountsCtx = ctx
		void syncAccounts(ctx).catch(() => {})
		void redirectAnthropic(pi, ctx).catch(() => {})
		void upgradeClaudeAlias(pi, ctx).catch(() => {})
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
		// Print/JSON runs exit after the turn; background CLI probes would only delay that.
		if (!ctx.hasUI) return
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
		// JEV routes turns to cheaper models by itself; only the user's own picks are remembered.
		const automatic = (globalThis.piAgentStackAutomaticChange ?? 0) > 0
		if (!automatic && event.model?.provider && event.model.id) {
			// Model only: thinking is recorded when the user changes it (or when leaving a provider).
			remember(event.model.provider, { model: event.model.id })
		}
		void redirectAnthropic(pi, ctx, event.model).catch(() => {})
		void refreshUsageStatus(ctx, event.model?.provider).catch(() => {})
		if (event.source === 'restore' || automatic) return
		if (event.model?.provider && event.model?.id) {
			autoPersistDefault({
				defaultProvider: event.model.provider,
				defaultModel: event.model.id
			})
		}
	})

	pi.on('thinking_level_select', (event, ctx) => {
		if ((globalThis.piAgentStackAutomaticChange ?? 0) > 0) return
		if (event.level && ctx.model)
			remember(ctx.model.provider, { model: ctx.model.id, thinking: event.level })
		if (event.level) {
			autoPersistDefault({
				defaultThinkingLevel: event.level
			})
		}
	})
}
