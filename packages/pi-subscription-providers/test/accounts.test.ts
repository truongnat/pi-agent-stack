import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
	blockActive,
	captureLive,
	chooseAccount,
	failedBeforeOutput,
	identify,
	livePools,
	poolForProvider,
	readLive,
	readStore,
	rotationReason,
	updateStore,
	writeLive,
	type AccountStore,
	type Paths
} from '../src/accounts.ts'

const NOW = 1_790_000_000_000

function paths(): Paths {
	const root = mkdtempSync(join(tmpdir(), 'accounts-'))
	const p = { agentDir: join(root, 'agent'), home: join(root, 'home') }
	mkdirSync(p.agentDir, { recursive: true })
	mkdirSync(join(p.home, '.claude'), { recursive: true })
	return p
}

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

const codexCred = (accountId: string, email: string) => ({
	type: 'oauth',
	access: jwt({
		'https://api.openai.com/auth': { chatgpt_account_id: accountId },
		'https://api.openai.com/profile': { email }
	}),
	refresh: `r-${accountId}`,
	expires: NOW + 3_600_000,
	accountId
})

test('identity comes from local login data: JWT, Claude oauthAccount, or key fingerprint', () => {
	assert.deepEqual(identify(codexCred('acc-1', 'a@x.com')), { key: 'acc-1', label: 'a@x.com' })
	assert.deepEqual(
		identify({
			claudeAiOauth: { accessToken: 'sk-ant-oat-opaque' },
			oauthAccount: { accountUuid: 'u-1', emailAddress: 'c@x.com' }
		}),
		{ key: 'u-1', label: 'c@x.com' }
	)
	const key = identify({ type: 'api_key', key: 'sk-deepseek-secret-1234' })
	assert.match(key?.key ?? '', /^fp:[0-9a-f]{16}$/)
	assert.equal(key?.label, '…1234', 'label never shows the secret')
})

test('a second login is saved alongside the first instead of replacing it', () => {
	const p = paths()
	const auth = join(p.agentDir, 'auth.json')
	writeFileSync(auth, JSON.stringify({ 'openai-codex': codexCred('acc-1', 'a@x.com') }))
	let store: AccountStore = {}
	const first = captureLive('pi:openai-codex', store, NOW, p)
	assert.equal(first.added, true)
	store = first.store
	writeFileSync(auth, JSON.stringify({ 'openai-codex': codexCred('acc-2', 'b@x.com') }))
	const second = captureLive('pi:openai-codex', store, NOW, p)
	assert.equal(second.added, true)
	assert.deepEqual(Object.keys(second.store['pi:openai-codex']?.accounts ?? {}).toSorted(), [
		'acc-1',
		'acc-2'
	])
	assert.equal(second.store['pi:openai-codex']?.active, 'acc-2')
	writeFileSync(
		auth,
		JSON.stringify({
			'openai-codex': codexCred('acc-2', 'b@x.com'),
			typesafe: { type: 'api_key', key: '!python3 print-key.py' }
		})
	)
	assert.deepEqual(livePools(p), ['pi:openai-codex'], 'command-valued keys are not pooled')
	assert.equal(poolForProvider('openai-codex', livePools(p)), 'pi:openai-codex')
	assert.equal(poolForProvider('deepseek', livePools(p)), undefined, 'no login, no pool')
})

test('writeLive swaps one auth.json entry under the lock and keeps the others', () => {
	const p = paths()
	const auth = join(p.agentDir, 'auth.json')
	writeFileSync(
		auth,
		JSON.stringify({
			'openai-codex': codexCred('acc-1', 'a@x.com'),
			xai: { type: 'api_key', key: 'k' }
		})
	)
	writeLive('pi:openai-codex', codexCred('acc-2', 'b@x.com'), p)
	const after = JSON.parse(readFileSync(auth, 'utf8'))
	assert.equal(after['openai-codex'].accountId, 'acc-2')
	assert.deepEqual(after.xai, { type: 'api_key', key: 'k' })
	assert.equal(statSync(auth).mode & 0o777, 0o600)
	assert.throws(() => statSync(`${auth}.lock`), 'lock released')
})

test('claude-code swaps tokens and patches only oauthAccount in ~/.claude.json', () => {
	const p = paths()
	writeFileSync(
		join(p.home, '.claude', '.credentials.json'),
		JSON.stringify({ claudeAiOauth: { accessToken: 't1' } })
	)
	writeFileSync(
		join(p.home, '.claude.json'),
		JSON.stringify({ numStartups: 7, oauthAccount: { accountUuid: 'u-1' } })
	)
	const live = readLive('claude-code', p)
	assert.deepEqual(live?.oauthAccount, { accountUuid: 'u-1' }, 'identity read from ~/.claude.json')
	writeLive(
		'claude-code',
		{ claudeAiOauth: { accessToken: 't2' }, oauthAccount: { accountUuid: 'u-2' } },
		p
	)
	const creds = JSON.parse(readFileSync(join(p.home, '.claude', '.credentials.json'), 'utf8'))
	const config = JSON.parse(readFileSync(join(p.home, '.claude.json'), 'utf8'))
	assert.deepEqual(
		creds,
		{ claudeAiOauth: { accessToken: 't2' } },
		'no profile data in the token file'
	)
	assert.equal(config.oauthAccount.accountUuid, 'u-2')
	assert.equal(config.numStartups, 7, 'rest of Claude Code config untouched')
})

test('rotation: exhausted active account switches to one with quota; blocked ones are skipped', async () => {
	const acct = (key: string) => ({
		key,
		label: key,
		credential: codexCred(key, `${key}@x.com`),
		savedAt: NOW
	})
	const check = async (_pool: string, token: string) => {
		const spent = identify({ access: token })?.key === 'a'
		return { windows: [{ label: '5h', usedPercent: spent ? 100 : 20, resetsAt: NOW + 7_200_000 }] }
	}
	const store: AccountStore = {
		'pi:openai-codex': {
			active: 'a',
			accounts: {
				a: acct('a'),
				b: { ...acct('b'), blockedUntil: NOW + 3_600_000, blockedReason: 'limit reached' },
				c: acct('c')
			}
		}
	}
	const result = await chooseAccount('pi:openai-codex', store, check, NOW)
	assert.equal(result.switchTo?.key, 'c', 'b is blocked, a is spent')
	assert.equal(result.reason, 'quota exhausted')
	assert.equal(result.store['pi:openai-codex']?.active, 'c')
	assert.equal(result.store['pi:openai-codex']?.accounts.a?.blockedUntil, NOW + 7_200_000)

	const blocked = blockActive('pi:openai-codex', store, 'login failed', NOW + 1)
	assert.equal(blocked['pi:openai-codex']?.accounts.a?.blockedReason, 'login failed')

	const single: AccountStore = { 'pi:openai-codex': { active: 'a', accounts: { a: acct('a') } } }
	assert.equal(
		(await chooseAccount('pi:openai-codex', single, check, NOW)).switchTo,
		undefined,
		'one account: nothing to rotate to'
	)
})

test('turn errors that should rotate', () => {
	assert.equal(rotationReason('You have hit your ChatGPT usage limit (plus plan).'), 'quota')
	assert.equal(rotationReason('429 rate_limit_exceeded'), 'quota')
	assert.equal(rotationReason('OAuth refresh failed: invalid_grant'), 'auth')
	assert.equal(rotationReason('No API key found for claude-code.'), 'auth')
	assert.equal(rotationReason('context length exceeded'), undefined)
})

test('opaque OAuth tokens keep one slot across refreshes instead of multiplying', () => {
	const before = identify({ type: 'oauth', access: 'sk-ant-oat01-AAAA', refresh: 'r1', expires: 1 })
	const after = identify({ type: 'oauth', access: 'sk-ant-oat01-BBBB', refresh: 'r2', expires: 2 })
	assert.equal(before?.key, after?.key)
})

test('updateStore applies each change to the latest copy (several Pi sessions)', () => {
	const p = paths()
	const stale = readStore(p)
	updateStore((s) => ({ ...s, 'pi:a': { accounts: {} } }), p)
	// A second session holding a stale copy still keeps the first session's change.
	updateStore((s) => ({ ...s, 'pi:b': { accounts: {} } }), p)
	assert.deepEqual(Object.keys(readStore(p)).toSorted(), ['pi:a', 'pi:b'])
	assert.deepEqual(stale, {})
	assert.throws(() => statSync(join(p.agentDir, 'accounts.json.lock')), 'lock released')
})

test('resend after a switch only when the failed reply showed nothing', () => {
	assert.equal(failedBeforeOutput({ content: [] }), true)
	assert.equal(failedBeforeOutput({ content: [{ type: 'text', text: '  ' }] }), true)
	assert.equal(failedBeforeOutput({ content: [{ type: 'text', text: 'Partial answer' }] }), false)
	assert.equal(failedBeforeOutput({ content: [{ type: 'thinking', thinking: 'plan' }] }), false)
	assert.equal(failedBeforeOutput({ content: [{ type: 'toolCall' }] }), false)
})
