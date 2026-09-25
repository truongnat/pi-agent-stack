/**
 * Multi-account pools with automatic rotation, for every provider (Orca-style).
 *
 * Log in as usual (`/login <provider>`, `claude` → /login, `cursor-agent login`). When the live
 * credential belongs to an account the pool has not seen, it is saved next to the others
 * instead of being overwritten. When the active account hits its limit or its login dies and
 * the pool holds another usable account, that credential becomes the live one again.
 *
 * Pools:
 * - `pi:<provider>`: every entry of Pi's auth.json (OAuth or API key), written under the same
 *   proper-lockfile lock Pi uses (an `auth.json.lock` directory). Pi rereads the file when its
 *   revision changes, so a swap applies on the next request.
 * - `claude-code`: Claude Code's tokens (`~/.claude/.credentials.json`) plus the account it
 *   belongs to (`oauthAccount` in `~/.claude.json`), both swapped together.
 * - `cursor`: cursor-agent's `~/.config/cursor/auth.json`.
 * Antigravity keeps its login in the OS keyring and is not pooled.
 *
 * The pool file (`~/.pi/agent/accounts.json`, mode 600) holds credentials; it is never logged
 * or committed.
 */
import { createHash } from 'node:crypto'
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Quota, QuotaWindow } from './usage.ts'

export type PoolId = `pi:${string}` | 'claude-code' | 'cursor'

export type Account = {
	/** Stable identity: account id / email from the token, or a key fingerprint. */
	key: string
	label: string
	credential: unknown
	savedAt: number
	/** Set when the account hit its limit or its login died; cleared by a new credential. */
	blockedUntil?: number | undefined
	blockedReason?: string | undefined
}

export type Pool = { active?: string | undefined; accounts: Record<string, Account> }

export type AccountStore = Record<string, Pool>

export type Paths = { agentDir: string; home: string }

export function defaultPaths(): Paths {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
	return { agentDir, home: homedir() }
}

const storePath = (p: Paths) => join(p.agentDir, 'accounts.json')
const authPath = (p: Paths) => join(p.agentDir, 'auth.json')
const cliPath: Record<'claude-code' | 'cursor', (p: Paths) => string> = {
	'claude-code': (p) => join(p.home, '.claude', '.credentials.json'),
	cursor: (p) => join(p.home, '.config', 'cursor', 'auth.json')
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return undefined
	}
}

function readObject(path: string): Record<string, unknown> | undefined {
	const value = readJson(path)
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** Atomic write with owner-only permissions (credentials). */
function writeSecret(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
	chmodSync(tmp, 0o600)
	renameSync(tmp, path)
}

export function readStore(p: Paths = defaultPaths()): AccountStore {
	return (readObject(storePath(p)) as AccountStore | undefined) ?? {}
}

export function writeStore(store: AccountStore, p: Paths = defaultPaths()): void {
	updateStore(() => store, p)
}

/**
 * Read-modify-write under a lock: several Pi sessions share the store, so each change is
 * applied to the latest copy instead of overwriting it with a stale one.
 */
export function updateStore(
	change: (current: AccountStore) => AccountStore,
	p: Paths = defaultPaths()
): AccountStore {
	const file = storePath(p)
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	return withFileLock(file, () => {
		const next = change(readStore(p))
		writeSecret(file, next)
		return next
	})
}

const LOCK_STALE_MS = 30_000
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Same lock as Pi's proper-lockfile: an `<file>.lock` directory, stale after 30 s. */
function withFileLock<T>(file: string, fn: () => T): T {
	const lock = `${file}.lock`
	const deadline = Date.now() + 10_000
	for (;;) {
		try {
			mkdirSync(lock)
			break
		} catch (error) {
			if ((error as { code?: string }).code !== 'EEXIST') throw error
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock)
			} catch {
				// Lock vanished between checks; retry.
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`, { cause: error })
			sleepSync(50)
		}
	}
	try {
		return fn()
	} finally {
		rmdirSync(lock)
	}
}

function jwtClaims(token: unknown): Record<string, unknown> | undefined {
	if (typeof token !== 'string' || token.split('.').length !== 3) return undefined
	try {
		const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
		return claims && typeof claims === 'object' ? claims : undefined
	} catch {
		return undefined
	}
}

const fingerprint = (secret: string) =>
	createHash('sha256').update(secret).digest('hex').slice(0, 16)

/** Identity of a credential: account id / email from a JWT, else a fingerprint of the secret. */
export function identify(
	credential: Record<string, unknown>
): { key: string; label: string } | undefined {
	const account = credential.oauthAccount as
		{ accountUuid?: string; emailAddress?: string } | undefined
	if (account?.accountUuid) {
		return { key: account.accountUuid, label: account.emailAddress ?? account.accountUuid }
	}
	const token =
		credential.access ??
		credential.accessToken ??
		credential.key ??
		credential.apiKey ??
		credential.refresh
	if (typeof token !== 'string' || !token) {
		const nested = credential.claudeAiOauth
		return nested && typeof nested === 'object'
			? identify(nested as Record<string, unknown>)
			: undefined
	}
	const claims = jwtClaims(token)
	const openai = claims?.['https://api.openai.com/auth'] as
		{ chatgpt_account_id?: string } | undefined
	const profile = claims?.['https://api.openai.com/profile'] as { email?: string } | undefined
	const email = profile?.email ?? (typeof claims?.email === 'string' ? claims.email : undefined)
	const id =
		(typeof credential.accountId === 'string' ? credential.accountId : undefined) ??
		openai?.chatgpt_account_id ??
		(typeof claims?.sub === 'string' ? claims.sub : undefined)
	if (id) return { key: id, label: email ?? id }
	// Opaque OAuth tokens (no claims) change on every refresh, so a fingerprint would turn one
	// account into many; without identity in the login data the provider keeps one slot.
	const oauth =
		credential.type === 'oauth' || 'refresh' in credential || 'refreshToken' in credential
	if (!claims && oauth) return { key: 'oauth-login', label: 'signed-in account' }
	// API key: stable per key; the label never shows the secret.
	return { key: `fp:${fingerprint(token)}`, label: email ?? `…${token.slice(-4)}` }
}

/** Every pool with a live credential on this machine. */
export function livePools(p: Paths = defaultPaths()): PoolId[] {
	// Command-valued keys (`!cmd`) are resolved by Pi on every request: nothing to rotate.
	const pools: PoolId[] = Object.entries(readObject(authPath(p)) ?? {})
		.filter(([, c]) => !String((c as { key?: unknown } | undefined)?.key ?? '').startsWith('!'))
		.map(([id]) => `pi:${id}` as const)
	for (const cli of ['claude-code', 'cursor'] as const) {
		if (readObject(cliPath[cli](p))) pools.push(cli)
	}
	return pools
}

export function readLive(
	pool: PoolId,
	p: Paths = defaultPaths()
): Record<string, unknown> | undefined {
	if (pool.startsWith('pi:')) {
		const entry = readObject(authPath(p))?.[pool.slice(3)]
		return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined
	}
	const file = readObject(cliPath[pool as 'claude-code' | 'cursor'](p))
	if (pool !== 'claude-code' || !file) return file
	// Identity lives next to the tokens in Claude Code's config; no profile call needed.
	const oauthAccount = readObject(claudeConfigPath(p))?.oauthAccount
	return oauthAccount ? { ...file, oauthAccount } : file
}

const claudeConfigPath = (p: Paths) => join(p.home, '.claude.json')

/** The credential without volatile profile data, for change detection. */
function tokenPart(credential: unknown): string {
	const { oauthAccount: _profile, ...rest } = (credential ?? {}) as Record<string, unknown>
	return JSON.stringify(rest)
}

export function writeLive(pool: PoolId, credential: unknown, p: Paths = defaultPaths()): void {
	if (pool.startsWith('pi:')) {
		const file = authPath(p)
		withFileLock(file, () => {
			writeSecret(file, { ...readObject(file), [pool.slice(3)]: credential })
		})
		return
	}
	if (pool !== 'claude-code') {
		writeSecret(cliPath[pool as 'cursor'](p), credential)
		return
	}
	const { oauthAccount, ...tokens } = credential as Record<string, unknown>
	writeSecret(cliPath['claude-code'](p), tokens)
	if (oauthAccount) {
		// Patch only the account block; the rest of ~/.claude.json belongs to Claude Code.
		writeSecret(claudeConfigPath(p), { ...readObject(claudeConfigPath(p)), oauthAccount })
	}
}

/**
 * Save the live credential into its pool: a new account is added, a known one refreshed
 * (tokens rotate on refresh, so the pool follows the live copy).
 */
export function captureLive(
	pool: PoolId,
	store: AccountStore,
	now = Date.now(),
	p: Paths = defaultPaths(),
	identity?: { key: string; label: string }
): { store: AccountStore; key?: string; added: boolean } {
	const credential = readLive(pool, p)
	const id = identity ?? (credential ? identify(credential) : undefined)
	if (!credential || !id) return { store, added: false }
	const current = store[pool] ?? { accounts: {} }
	const existing = current.accounts[id.key]
	const unchanged = existing && tokenPart(existing.credential) === tokenPart(credential)
	const account: Account = {
		key: id.key,
		label: identity?.label ?? existing?.label ?? id.label,
		credential,
		savedAt: now,
		// A new credential (re-login or refresh) is worth trying again.
		...(unchanged
			? { blockedUntil: existing.blockedUntil, blockedReason: existing.blockedReason }
			: {})
	}
	return {
		store: {
			...store,
			[pool]: { active: id.key, accounts: { ...current.accounts, [id.key]: account } }
		},
		key: id.key,
		added: !existing
	}
}

/** Pool used by a Pi provider id. */
export function poolForProvider(
	provider: string | undefined,
	pools: readonly PoolId[]
): PoolId | undefined {
	if (!provider) return undefined
	if (provider === 'claude-code' || provider === 'cursor')
		return pools.includes(provider) ? provider : undefined
	const pool = `pi:${provider}` as const
	return pools.includes(pool) ? pool : undefined
}

/** Valid access token of a stored account (inactive accounts are not refreshed). */
export function accessToken(pool: PoolId, account: Account, now = Date.now()): string | undefined {
	const c = account.credential as Record<string, unknown>
	const oauth = (pool === 'claude-code' ? c.claudeAiOauth : c) as
		Record<string, unknown> | undefined
	const token = oauth?.access ?? oauth?.accessToken
	const expires = Number(oauth?.expires ?? oauth?.expiresAt ?? 0)
	return typeof token === 'string' && expires > now ? token : undefined
}

/** Plan name from the login data itself (ChatGPT token claim, Claude subscription type). */
export function accountPlan(pool: PoolId, credential: unknown): string | undefined {
	const c = (credential ?? {}) as Record<string, unknown>
	if (pool === 'claude-code') {
		const plan = (c.claudeAiOauth as { subscriptionType?: unknown } | undefined)?.subscriptionType
		return typeof plan === 'string' ? plan : undefined
	}
	const auth = jwtClaims(c.access)?.['https://api.openai.com/auth'] as
		{ chatgpt_plan_type?: unknown } | undefined
	return typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined
}

/** When an exhausted account frees up: the latest reset among its spent windows. */
export function blockedUntil(
	windows: readonly QuotaWindow[],
	now = Date.now()
): number | undefined {
	const spent = windows.filter((w) => w.usedPercent >= 100)
	if (spent.length === 0) return undefined
	return Math.max(...spent.map((w) => w.resetsAt ?? now + 60 * 60_000))
}

export type QuotaCheck = (pool: PoolId, token: string) => Promise<Quota | undefined>

/**
 * Account to use next: the active one while it works, otherwise the first other account that
 * is not blocked and, when its quota can be read, not exhausted.
 */
export async function chooseAccount(
	pool: PoolId,
	store: AccountStore,
	check: QuotaCheck,
	now = Date.now()
): Promise<{ store: AccountStore; switchTo?: Account; reason?: string }> {
	const current = store[pool]
	if (!current?.active || Object.keys(current.accounts).length < 2) return { store }
	const accounts = { ...current.accounts }
	const assess = async (account: Account): Promise<string | undefined> => {
		if (account.blockedUntil && account.blockedUntil > now)
			return account.blockedReason ?? 'blocked'
		const token = accessToken(pool, account, now)
		if (!token) return undefined // Unknown quota: usable; the harness refreshes on use.
		const quota = await check(pool, token).catch(() => undefined)
		const until = quota ? blockedUntil(quota.windows, now) : undefined
		if (!until) return undefined
		accounts[account.key] = { ...account, blockedUntil: until, blockedReason: 'quota exhausted' }
		return 'quota exhausted'
	}
	const active = accounts[current.active]
	if (!active) return { store }
	const reason = await assess(active)
	if (!reason) return { store: { ...store, [pool]: { ...current, accounts } } }
	for (const account of Object.values(accounts)) {
		if (account.key !== active.key && !(await assess(account))) {
			return {
				store: { ...store, [pool]: { active: account.key, accounts } },
				switchTo: account,
				reason
			}
		}
	}
	return { store: { ...store, [pool]: { ...current, accounts } } }
}

/** Mark the active account unusable (limit hit or login dead) until `until`. */
export function blockActive(
	pool: PoolId,
	store: AccountStore,
	reason: string,
	until: number
): AccountStore {
	const current = store[pool]
	const active = current?.active ? current.accounts[current.active] : undefined
	if (!current || !active) return store
	return {
		...store,
		[pool]: {
			...current,
			accounts: {
				...current.accounts,
				[active.key]: { ...active, blockedUntil: until, blockedReason: reason }
			}
		}
	}
}

/** Classify an assistant error as a reason to rotate. */
export function rotationReason(errorMessage: string | undefined): 'quota' | 'auth' | undefined {
	if (!errorMessage) return undefined
	if (
		/usage.?limit|rate.?limit|quota|hit your|limit reached|insufficient balance|\b429\b/i.test(
			errorMessage
		)
	) {
		return 'quota'
	}
	if (
		/invalid_grant|refresh token|authentication failed|re-authenticate|\b401\b|unauthorized|no api key|login expired/i.test(
			errorMessage
		)
	) {
		return 'auth'
	}
	return undefined
}

type FailedReply = { content?: ReadonlyArray<{ type: string; text?: string; thinking?: string }> }

/**
 * After a switch, resend a failed request only when the failed reply produced nothing: no
 * text, no thinking, no tool call. Earlier tool results stay in context, so nothing reruns.
 */
export function failedBeforeOutput(reply: FailedReply): boolean {
	return !(reply.content ?? []).some(
		(block) => block.type === 'toolCall' || (block.text ?? block.thinking ?? '').trim()
	)
}

type Window = { used_percent?: number; utilization?: number; reset_at?: number; resets_at?: string }

/**
 * Quota readable per token (no model call): ChatGPT/Codex and Claude OAuth. Other providers
 * rotate on the error that ends a turn instead.
 */
export const httpQuota: QuotaCheck = async (pool, token) => {
	const codex = pool === 'pi:openai-codex'
	const claude = pool === 'claude-code' || pool === 'pi:anthropic'
	if (!codex && !claude) return undefined
	const accountId = codex
		? (
				jwtClaims(token)?.['https://api.openai.com/auth'] as
					{ chatgpt_account_id?: string } | undefined
			)?.chatgpt_account_id
		: undefined
	const res = await fetch(
		codex
			? 'https://chatgpt.com/backend-api/wham/usage'
			: 'https://api.anthropic.com/api/oauth/usage',
		{
			headers: {
				Authorization: `Bearer ${token}`,
				...(accountId ? { 'chatgpt-account-id': accountId } : {}),
				...(claude ? { 'anthropic-beta': 'oauth-2025-04-20' } : {})
			},
			redirect: 'error',
			signal: AbortSignal.timeout(8000)
		}
	)
	if (!res.ok) return undefined
	const body = (await res.json()) as {
		rate_limit?: { primary_window?: Window | null; secondary_window?: Window | null }
		five_hour?: Window | null
		seven_day?: Window | null
	}
	const raw: Array<[string, Window | null | undefined]> = codex
		? [
				['5h', body.rate_limit?.primary_window],
				['week', body.rate_limit?.secondary_window]
			]
		: [
				['5h', body.five_hour],
				['week', body.seven_day]
			]
	const windows: QuotaWindow[] = []
	for (const [label, w] of raw) {
		const used = w?.used_percent ?? w?.utilization
		if (typeof used !== 'number') continue
		const reset =
			typeof w?.reset_at === 'number' ? w.reset_at * 1000 : Date.parse(w?.resets_at ?? '')
		windows.push({ label, usedPercent: used, resetsAt: Number.isFinite(reset) ? reset : undefined })
	}
	return { windows }
}

/** Files to watch for logins, per pool family. */
export function watchedFiles(p: Paths = defaultPaths()): string[] {
	return [authPath(p), cliPath['claude-code'](p), cliPath.cursor(p)]
}
