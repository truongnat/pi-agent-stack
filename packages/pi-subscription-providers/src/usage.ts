/**
 * Plan quota, balance, and account for the footer and /usage, in one format for every provider.
 * Each provider is read through its own official tool whenever one exists:
 *
 * - Codex: `codex app-server` JSON-RPC (`account/rateLimits/read`, `account/read`), the data
 *   behind the TUI's `/status`.
 * - Claude: `claude auth status` + `claude -p /usage` (Claude Code's own slash command).
 * - Antigravity: `agy -p /usage` (agy's own slash command; TSV of remaining %).
 * - Cursor: `/usage` is TUI-only (print mode sends it to the model), so the dashboard RPCs that
 *   modal calls (`DashboardService/GetCurrentPeriodUsage`) with cursor-agent's own login
 *   (`~/.config/cursor/auth.json`), plus `cursor-agent about --format json` for tier + account.
 * - Grok: `/usage` is TUI-only (in print mode it becomes a model prompt), so the billing
 *   endpoint that modal calls is used, with Pi's xAI OAuth or the Grok CLI login token.
 * - DeepSeek: documented account balance endpoint (Pi's API key).
 *
 * A provider whose tool is missing or not logged in yields undefined and is not shown.
 * Tokens are never logged or persisted.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { allowlistEnv } from './env.ts'

export type QuotaWindow = { label: string; usedPercent: number; resetsAt?: number | undefined }

export type Balance = { currency: string; amount: number }

export type Quota = {
	plan?: string | undefined
	/** Signed-in account (email), shown only on the user's own screen. */
	account?: string | undefined
	windows: QuotaWindow[]
	balances?: Balance[] | undefined
	/** Short problem flag, e.g. "insufficient balance". */
	alert?: string | undefined
}

export type CliRunner = (command: string, args: string[]) => Promise<string>

export type CodexStatus = { rateLimits?: unknown; account?: unknown }

export type UsageDeps = {
	getApiKeyForProvider(provider: string): Promise<string | undefined>
	/** Pi's auth source label ("OAuth", "XAI_API_KEY", ...), used to tell subscriptions from keys. */
	authSource?: (provider: string) => Promise<string | undefined>
	/** Resolved CLI binary for Cursor/Antigravity, only when readiness passed. */
	cliCommand?: (provider: string) => string | undefined
	run?: CliRunner
	codexStatus?: () => Promise<CodexStatus>
	grokLogin?: () => GrokLogin | undefined
	cursorToken?: () => string | undefined
}

const DISPLAY_NAMES: Record<string, string> = {
	anthropic: 'claude',
	'openai-codex': 'codex',
	xai: 'grok',
	'claude-code': 'claude'
}

export function displayName(provider: string): string {
	return DISPLAY_NAMES[provider] ?? provider
}

function windowLabel(minutes: number | undefined, fallback: string): string {
	if (!minutes) return fallback
	if (minutes === 10080) return 'week'
	if (minutes % 1440 === 0) return `${minutes / 1440}d`
	return `${Math.round(minutes / 60)}h`
}

type CodexWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null

/** `codex app-server` results for account/rateLimits/read and account/read. */
export function parseCodexStatus(status: CodexStatus): Quota | undefined {
	const account = (status.account as { account?: { email?: string; planType?: string } | null })
		?.account
	if (!account) return undefined
	const limits = (
		status.rateLimits as {
			rateLimits?: {
				primary?: CodexWindow
				secondary?: CodexWindow
				planType?: string
				rateLimitReachedType?: string | null
			}
		}
	)?.rateLimits
	const windows: QuotaWindow[] = []
	for (const [w, fallback] of [
		[limits?.primary, '5h'],
		[limits?.secondary, 'week']
	] as const) {
		if (typeof w?.usedPercent !== 'number') continue
		windows.push({
			label: windowLabel(w.windowDurationMins, fallback),
			usedPercent: w.usedPercent,
			resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined
		})
	}
	const rpcError = (status.rateLimits as { error?: { message?: string } } | undefined)?.error
	let alert: string | undefined
	if (limits?.rateLimitReachedType) alert = 'limit reached'
	else if (!limits)
		alert = `rate limits unavailable${rpcError?.message ? `: ${rpcError.message}` : ''}`
	return { plan: account.planType ?? limits?.planType, account: account.email, windows, alert }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Offset (ms) of an IANA zone at instant `t`. */
function zoneOffset(timeZone: string, t: number): number {
	const parts: Record<string, number> = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric'
		})
			.formatToParts(t)
			.map((p) => [p.type, Number(p.value)])
	)
	const part = (type: string) => parts[type] ?? 0
	const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'))
	return wall - Math.floor(t / 60_000) * 60_000
}

/** "Sep 25, 1:29pm (Asia/Bangkok)" → epoch ms; the year rolls over when the date has passed. */
export function parseClaudeReset(text: string, now = Date.now()): number | undefined {
	const m =
		/^([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(
			text.trim()
		)
	if (!m) return undefined
	const [, mon = '', day = '', hour = '', minute, meridiem = '', zone = ''] = m
	const month = MONTHS.indexOf(mon.toLowerCase())
	if (month < 0) return undefined
	const h = (Number(hour) % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0)
	const at = (year: number) => {
		const guess = Date.UTC(year, month, Number(day), h, Number(minute ?? 0))
		try {
			return guess - zoneOffset(zone, guess)
		} catch {
			return guess
		}
	}
	const year = new Date(now).getUTCFullYear()
	const t = at(year)
	return t < now - 86_400_000 ? at(year + 1) : t
}

/** `claude -p /usage` text: "Current session: 67% used · resets Sep 25, 1:29pm (Asia/Bangkok)". */
export function parseClaudeUsageText(stdout: string, now = Date.now()): QuotaWindow[] {
	const windows: QuotaWindow[] = []
	for (const line of stdout.split('\n')) {
		const m =
			/^\s*Current (session|week)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?/i.exec(
				line
			)
		if (!m) continue
		const [, span = '', scope, percent = '0', reset] = m
		let label = '5h'
		if (span.toLowerCase() === 'week') {
			label = !scope || /all models/i.test(scope) ? 'week' : `${scope.toLowerCase()} week`
		}
		windows.push({
			label,
			usedPercent: Number(percent),
			resetsAt: reset ? parseClaudeReset(reset, now) : undefined
		})
	}
	return windows
}

export function parseDeepseekBalance(body: unknown): Quota {
	const data = (body ?? {}) as {
		is_available?: boolean
		balance_infos?: Array<{ currency?: string; total_balance?: string }>
	}
	const balances = (data.balance_infos ?? [])
		.map((b) => ({ currency: b.currency ?? '', amount: Number(b.total_balance) }))
		.filter((b) => b.currency && Number.isFinite(b.amount))
	return {
		plan: 'api',
		windows: [],
		balances,
		alert: data.is_available === false ? 'insufficient balance' : undefined
	}
}

type GrokConfig = {
	creditUsagePercent?: number | string
	currentPeriod?: { end?: string }
	billingPeriodEnd?: string
	monthlyLimit?: { val?: number | string }
	used?: { val?: number | string }
}

export function parseGrokBilling(billing: unknown, settings: unknown): Quota {
	const config: GrokConfig = (billing as { config?: GrokConfig } | undefined)?.config ?? {}
	const plan = (settings as { subscription_tier_display?: string } | undefined)
		?.subscription_tier_display
	const end = Date.parse(config.currentPeriod?.end ?? config.billingPeriodEnd ?? '')
	const resetsAt = Number.isFinite(end) ? end : undefined
	const windows: QuotaWindow[] = []
	const weekly = Number(config.creditUsagePercent)
	const limit = Number(config.monthlyLimit?.val)
	const used = Number(config.used?.val)
	// SuperGrok unified billing is a weekly credit pool; older accounts report monthly totals.
	if (Number.isFinite(weekly)) windows.push({ label: 'week', usedPercent: weekly, resetsAt })
	else if (limit > 0 && Number.isFinite(used)) {
		windows.push({ label: 'month', usedPercent: (used / limit) * 100, resetsAt })
	}
	return { plan: plan?.toLowerCase(), windows }
}

/** Short group names: "Claude and GPT models" → "claude+gpt". */
function agyGroup(group: string): string {
	return group
		.toLowerCase()
		.replace(/\s+models?$/, '')
		.replace(/\s+and\s+/g, '+')
		.trim()
}

/** `agy -p /usage` lines: group, window, percent, reset ISO (tab-separated). */
export function parseAgyUsage(stdout: string): Quota {
	const windows: QuotaWindow[] = []
	for (const line of stdout.split('\n')) {
		const [group, window, percent, reset] = line.split('\t').map((cell) => cell.trim())
		const value = Number.parseFloat(percent ?? '')
		if (!group || !window || !Number.isFinite(value)) continue
		let span = window.toLowerCase().replace(/\s*limit.*$/, '')
		if (/five hour/i.test(window)) span = '5h'
		else if (/week/i.test(window)) span = 'week'
		const resetsAt = Date.parse(reset ?? '')
		windows.push({
			label: `${agyGroup(group)} ${span}`,
			usedPercent: /remaining/i.test(window) ? 100 - value : value,
			resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined
		})
	}
	return { windows }
}

export function parseCursorAbout(stdout: string): Quota {
	const data = JSON.parse(stdout) as { subscriptionTier?: string; userEmail?: string }
	return { plan: data.subscriptionTier?.toLowerCase(), account: data.userEmail, windows: [] }
}

type CursorUsage = {
	billingCycleEnd?: string
	planUsage?: { autoPercentUsed?: number; apiPercentUsed?: number; totalPercentUsed?: number }
	displayMessage?: string
}

/** `DashboardService/GetCurrentPeriodUsage`: auto and API pools for the billing cycle. */
export function parseCursorUsage(body: unknown): Pick<Quota, 'windows' | 'alert'> {
	const data = (body ?? {}) as CursorUsage
	const end = Number(data.billingCycleEnd)
	const resetsAt = Number.isFinite(end) && end > 0 ? end : undefined
	const windows: QuotaWindow[] = []
	for (const [label, value] of [
		['auto month', data.planUsage?.autoPercentUsed],
		['api month', data.planUsage?.apiPercentUsed]
	] as const) {
		if (typeof value === 'number') windows.push({ label, usedPercent: value, resetsAt })
	}
	const full = (data.planUsage?.totalPercentUsed ?? 0) >= 100
	return { windows, alert: full ? (data.displayMessage ?? 'usage limit reached') : undefined }
}

function jwtExpiry(token: string): number | undefined {
	try {
		const exp = JSON.parse(
			Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
		)?.exp
		return typeof exp === 'number' ? exp * 1000 : undefined
	} catch {
		return undefined
	}
}

/** Unexpired cursor-agent access token, used only for the dashboard usage RPC. */
export function readCursorToken(home = homedir(), now = Date.now()): string | undefined {
	try {
		const token = (
			JSON.parse(readFileSync(join(home, '.config/cursor/auth.json'), 'utf8')) as {
				accessToken?: string
			}
		).accessToken
		const exp = token ? jwtExpiry(token) : undefined
		return token && (exp === undefined || exp > now) ? token : undefined
	} catch {
		return undefined
	}
}

export type GrokLogin = { token: string; account?: string | undefined }

/** Unexpired token from the Grok CLI login (`~/.grok/auth.json`), used only for billing. */
export function readGrokLogin(home = homedir(), now = Date.now()): GrokLogin | undefined {
	let data: unknown
	try {
		data = JSON.parse(readFileSync(join(home, '.grok/auth.json'), 'utf8'))
	} catch {
		return undefined
	}
	const entries = Object.values(
		(data ?? {}) as Record<string, { key?: string; expires_at?: string; email?: string }>
	)
	const e = entries.find((x) => x?.key && Date.parse(x.expires_at ?? '') > now)
	return e?.key ? { token: e.key, account: e.email } : undefined
}

const FETCH_TIMEOUT_MS = 8000

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const res = await fetch(url, {
		headers,
		redirect: 'error',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

/** Connect-RPC unary call (JSON), as the Cursor CLI does. */
async function postJson(url: string, token: string): Promise<unknown> {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			'Connect-Protocol-Version': '1'
		},
		body: '{}',
		redirect: 'error',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

const CLI_TIMEOUT_MS = 30_000

// No output redaction: the account email is the point, and it is only rendered, never logged.
// stdin is closed: print-mode CLIs (Claude Code) otherwise wait for piped input before running.
const defaultRun: CliRunner = (command, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: allowlistEnv(),
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: CLI_TIMEOUT_MS
		})
		let stdout = ''
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}`))
		)
	})

/** One `codex app-server` session: initialize, then read rate limits and account. */
const defaultCodexStatus = (): Promise<CodexStatus> =>
	new Promise((resolve, reject) => {
		const child = spawn('codex', ['app-server'], {
			env: allowlistEnv(),
			stdio: ['pipe', 'pipe', 'ignore']
		})
		const results = new Map<number, unknown>()
		const send = (msg: object) =>
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
		const readLimits = { id: 2, method: 'account/rateLimits/read' }
		let retried = false
		const finish = (error?: Error) => {
			clearTimeout(timer)
			child.kill()
			if (error) reject(error)
			else resolve({ rateLimits: results.get(2), account: results.get(3) })
		}
		const timer = setTimeout(() => finish(new Error('codex app-server timed out')), CLI_TIMEOUT_MS)
		child.on('error', (error) => finish(error))
		createInterface({ input: child.stdout }).on('line', (line) => {
			try {
				const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
				// The backend fetch behind rate limits fails transiently; retry it once.
				if (msg.id === 2 && msg.error && !retried) {
					retried = true
					setTimeout(() => send(readLimits), 1000)
				} else if (msg.id === 2 || msg.id === 3) {
					results.set(msg.id, msg.result ?? { error: msg.error })
				}
			} catch {
				// Non-JSON log lines are ignored.
			}
			if (results.size === 2) finish()
		})
		send({
			id: 1,
			method: 'initialize',
			params: { clientInfo: { name: 'pi-usage', version: '0.1.0' } }
		})
		send({ method: 'initialized' })
		send(readLimits)
		send({ id: 3, method: 'account/read', params: {} })
	})

/** Missing binary means "not installed": hide the provider instead of reporting an error. */
function notInstalled(error: unknown): boolean {
	return (error as { code?: string } | undefined)?.code === 'ENOENT'
}

async function optional<T>(work: () => Promise<T>): Promise<T | undefined> {
	try {
		return await work()
	} catch (error) {
		if (notInstalled(error)) return undefined
		throw error
	}
}

const TOKEN_TIMEOUT_MS = 8000

/** Pi's token, or undefined when missing, failing, or hung (a stuck refresh must not stall). */
async function piToken(deps: UsageDeps, provider: string): Promise<string | undefined> {
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), TOKEN_TIMEOUT_MS)
	})
	try {
		return await Promise.race([deps.getApiKeyForProvider(provider).catch(() => undefined), timeout])
	} finally {
		clearTimeout(timer)
	}
}

type Fetcher = (deps: UsageDeps) => Promise<Quota | undefined>

const FETCHERS: Record<string, Fetcher> = {
	'openai-codex': (deps) =>
		optional(async () => parseCodexStatus(await (deps.codexStatus ?? defaultCodexStatus)())),
	anthropic: (deps) =>
		optional(async () => {
			const run = deps.run ?? defaultRun
			let auth: { loggedIn?: boolean; email?: string; subscriptionType?: string }
			try {
				auth = JSON.parse(await run('claude', ['auth', 'status', '--json']))
			} catch (error) {
				if (notInstalled(error)) throw error
				return undefined // Logged out: `claude auth status` exits non-zero.
			}
			if (!auth.loggedIn) return undefined
			return {
				plan: auth.subscriptionType,
				account: auth.email,
				// Local slash command, no model call; skip hooks and keep it out of session history.
				windows: parseClaudeUsageText(
					await run('claude', [
						'-p',
						'/usage',
						'--settings',
						'{"disableAllHooks":true}',
						'--no-session-persistence'
					])
				)
			}
		}),
	xai: async (deps) => {
		const piKey = await piToken(deps, 'xai')
		const piOAuth = piKey && (await deps.authSource?.('xai')) === 'OAuth'
		const login = piOAuth ? { token: piKey } : (deps.grokLogin ?? readGrokLogin)()
		if (!login) return piKey ? { plan: 'api', windows: [] } : undefined
		const headers = { Authorization: `Bearer ${login.token}` }
		const [billing, settings] = await Promise.all([
			getJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', headers),
			getJson('https://cli-chat-proxy.grok.com/v1/settings', headers).catch(() => undefined)
		])
		return {
			account: 'account' in login ? login.account : undefined,
			...parseGrokBilling(billing, settings)
		}
	},
	deepseek: async (deps) => {
		const key = await piToken(deps, 'deepseek')
		if (!key) return undefined
		return parseDeepseekBalance(
			await getJson('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${key}` })
		)
	},
	antigravity: async (deps) => {
		const command = deps.cliCommand?.('antigravity')
		if (!command) return undefined
		return parseAgyUsage(await (deps.run ?? defaultRun)(command, ['-p', '/usage']))
	},
	cursor: async (deps) => {
		const command = deps.cliCommand?.('cursor')
		if (!command) return undefined
		const token = (deps.cursorToken ?? readCursorToken)()
		const [about, usage] = await Promise.all([
			(deps.run ?? defaultRun)(command, ['about', '--format', 'json']),
			token
				? postJson(
						'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
						token
					).catch(() => undefined)
				: undefined
		])
		return { ...parseCursorAbout(about), ...(usage ? parseCursorUsage(usage) : {}) }
	}
}

// The claude-code provider runs on the same Claude Code login, so it shares Claude's quota.
FETCHERS['claude-code'] = (deps) => (FETCHERS.anthropic ?? (async () => undefined))(deps)

/** Providers /usage reports when installed and signed in, in display order. */
export const USAGE_PROVIDERS = [
	'anthropic',
	'openai-codex',
	'xai',
	'deepseek',
	'cursor',
	'antigravity'
] as const

/** CLI-backed providers cost a subprocess (Claude Code ~12 s), so they cache longer. */
const TTL_MS: Record<string, number> = {
	cursor: 10 * 60_000,
	antigravity: 5 * 60_000,
	anthropic: 5 * 60_000,
	'claude-code': 5 * 60_000,
	'openai-codex': 2 * 60_000
}
const DEFAULT_TTL_MS = 60_000

export type QuotaResult = { quota?: Quota | undefined; error?: string | undefined }

const cache = new Map<string, QuotaResult & { at: number }>()
const inflight = new Map<string, Promise<void>>()

/** Cached lookup; quota undefined when the provider is not installed or not signed in. */
export async function getQuota(
	provider: string,
	deps: UsageDeps,
	force = false
): Promise<QuotaResult | undefined> {
	const fetcher = FETCHERS[provider]
	if (!fetcher) return undefined
	const hit = cache.get(provider)
	const ttl = TTL_MS[provider] ?? DEFAULT_TTL_MS
	if (!force && hit && Date.now() - hit.at < ttl) return hit
	let pending = inflight.get(provider)
	if (!pending) {
		pending = (async () => {
			try {
				cache.set(provider, { quota: await fetcher(deps), at: Date.now() })
			} catch (error) {
				cache.set(provider, {
					error: error instanceof Error ? error.message : 'usage fetch failed',
					at: Date.now()
				})
			}
		})().finally(() => inflight.delete(provider))
		inflight.set(provider, pending)
	}
	await pending
	return cache.get(provider)
}

/**
 * True when every quota pool is used up. A pool is the label minus its window span
 * ("gemini week" → "gemini"); a pool is spent once any of its windows reaches 100%.
 */
export function quotaExhausted(quota: Quota): boolean {
	if (quota.windows.length === 0) return false
	const pools = new Map<string, boolean>()
	for (const w of quota.windows) {
		const pool = w.label.split(' ').slice(0, -1).join(' ')
		pools.set(pool, (pools.get(pool) ?? false) || w.usedPercent >= 100)
	}
	return [...pools.values()].every(Boolean)
}

export function formatDuration(ms: number): string {
	if (ms <= 0) return 'now'
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
	return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function formatBalance(b: Balance): string {
	const symbol = ({ USD: '$', CNY: '¥' } as Record<string, string>)[b.currency]
	return symbol ? `${symbol}${b.amount.toFixed(2)}` : `${b.amount.toFixed(2)} ${b.currency}`
}

export type Severity = 'success' | 'warning' | 'error'

export function severity(percent: number): Severity {
	if (percent >= 90) return 'error'
	if (percent >= 70) return 'warning'
	return 'success'
}

/** Subset of Pi's Theme used for rendering; identity in tests. */
export type Paint = {
	fg(color: Severity | 'accent' | 'muted' | 'dim' | 'text' | 'borderMuted', text: string): string
	bold(text: string): string
}

export const PLAIN: Paint = { fg: (_color, text) => text, bold: (text) => text }

/** True when the quota has anything worth showing. */
export function hasStatus(quota: Quota | undefined): quota is Quota {
	return Boolean(
		quota &&
		(quota.windows.length || quota.balances?.length || quota.account || quota.alert || quota.plan)
	)
}

function bar(percent: number, paint: Paint, width: number, on: string, off: string): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
	return (
		paint.fg(severity(percent), on.repeat(filled)) +
		paint.fg('borderMuted', off.repeat(width - filled))
	)
}

function pct(percent: number, paint: Paint): string {
	return paint.fg(severity(percent), `${Math.round(percent)}%`)
}

/** One-line status for the footer: `codex plus me@x.com (2/2)   5h ▰▱▱▱▱▱▱▱ 10% (2h08m)   week …`. */
export function formatStatusLine(
	provider: string,
	quota: Quota,
	paint: Paint = PLAIN,
	now = Date.now()
): string {
	// Account right after the provider: it is what tells the user which login is being used.
	const head =
		paint.fg('accent', displayName(provider)) +
		(quota.plan ? ` ${paint.fg('muted', quota.plan)}` : '') +
		(quota.account ? ` ${paint.fg('text', quota.account)}` : '')
	// Footer single-line display: limit to at most 2 primary windows so it fits cleanly in terminal
	const visibleWindows = quota.windows.length > 2 ? quota.windows.slice(0, 2) : quota.windows
	const parts = visibleWindows.map((w) => {
		const reset = w.resetsAt ? ` ${paint.fg('dim', `(${formatDuration(w.resetsAt - now)})`)}` : ''
		return `${paint.fg('muted', w.label)} ${bar(w.usedPercent, paint, 8, '▰', '▱')} ${pct(w.usedPercent, paint)}${reset}`
	})
	for (const b of quota.balances ?? []) {
		parts.push(`${paint.fg('muted', 'balance')} ${paint.fg('success', formatBalance(b))}`)
	}
	if (quota.alert) parts.push(paint.fg('error', `⚠ ${quota.alert}`))
	return [head, ...parts].join('   ')
}

function clock(ms: number): string {
	const d = new Date(ms)
	const day = d.toLocaleDateString('en-US', { weekday: 'short' })
	return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export type ReportRow = { provider: string; active: boolean; result?: QuotaResult | undefined }

/** Lines for /usage: same head as the footer, one row per window/balance/alert. */
export function renderReport(
	rows: readonly ReportRow[],
	paint: Paint = PLAIN,
	now = Date.now()
): string[] {
	const lines = [
		`${paint.bold(paint.fg('accent', 'Provider usage'))}  ${paint.fg('dim', clock(now))}`
	]
	if (rows.length === 0) {
		lines.push(paint.fg('muted', 'No signed-in providers detected on this machine.'))
		return lines
	}
	const width = Math.max(
		5,
		...rows.flatMap((r) => (r.result?.quota?.windows ?? []).map((w) => w.label.length))
	)
	const label = (text: string) => paint.fg('muted', text.padEnd(width))
	for (const row of rows) {
		const q = row.result?.quota
		lines.push(
			'',
			[
				row.active ? paint.fg('success', '●') : paint.fg('dim', '○'),
				paint.bold(displayName(row.provider)),
				...(q?.plan ? [paint.fg('accent', q.plan)] : []),
				...(q?.account ? [paint.fg('muted', q.account)] : []),
				...(row.active ? [paint.fg('success', '· active')] : [])
			].join(' ')
		)
		for (const w of q?.windows ?? []) {
			const percent = paint.fg(severity(w.usedPercent), `${Math.round(w.usedPercent)}%`.padStart(4))
			const reset = w.resetsAt
				? paint.fg('dim', `resets in ${formatDuration(w.resetsAt - now)} (${clock(w.resetsAt)})`)
				: ''
			lines.push(
				`  ${label(w.label)} ${bar(w.usedPercent, paint, 20, '━', '━')} ${percent}  ${reset}`.trimEnd()
			)
		}
		for (const b of q?.balances ?? []) {
			lines.push(`  ${label('bal')} ${paint.fg('success', formatBalance(b))}`)
		}
		if (q?.alert) lines.push(`  ${label('!')} ${paint.fg('error', `⚠ ${q.alert}`)}`)
		if (row.result?.error) {
			lines.push(`  ${label('!')} ${paint.fg('warning', `unavailable: ${row.result.error}`)}`)
		}
	}
	return lines
}
