import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
	formatDuration,
	formatStatusLine,
	getQuota,
	parseAgyUsage,
	parseClaudeReset,
	parseClaudeUsageText,
	parseCodexStatus,
	parseCursorUsage,
	parseDeepseekBalance,
	parseGrokBilling,
	quotaExhausted,
	readGrokLogin,
	renderReport,
	type UsageDeps
} from '../src/usage.ts'

const NOW = 1_790_000_000_000

const noPi: UsageDeps = {
	getApiKeyForProvider: async () => undefined,
	grokLogin: () => undefined,
	cursorToken: () => undefined
}

test('codex app-server status becomes the footer line', () => {
	const quota = parseCodexStatus({
		rateLimits: {
			rateLimits: {
				primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_790_003_600 },
				secondary: { usedPercent: 74, windowDurationMins: 10080, resetsAt: 1_790_086_400 }
			}
		},
		account: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' } }
	})
	assert.equal(
		formatStatusLine('openai-codex', quota ?? { windows: [] }, undefined, NOW),
		'codex plus   5h ▰▱▱▱▱▱▱▱ 10% (1h00m)   week ▰▰▰▰▰▰▱▱ 74% (1d0h)   · me@example.com'
	)
	assert.equal(parseCodexStatus({ account: { account: null } }), undefined, 'logged out')
	assert.equal(
		parseCodexStatus({
			rateLimits: { error: { message: 'network' } },
			account: { account: { email: 'a@b.c', planType: 'plus' } }
		})?.alert,
		'rate limits unavailable: network'
	)
})

test('claude /usage text and reset times in the stated zone', () => {
	const text = [
		'You are currently using your subscription to power your Claude Code usage',
		'',
		'Current session: 67% used · resets Sep 25, 1:29pm (Asia/Bangkok)',
		'Current week (all models): 26% used · resets Oct 1, 2:59am (Asia/Bangkok)',
		'Current week (Fable): 0% used · resets Oct 1, 3am (Asia/Bangkok)'
	].join('\n')
	const windows = parseClaudeUsageText(text, NOW)
	assert.deepEqual(
		windows.map((w) => [w.label, w.usedPercent]),
		[
			['5h', 67],
			['week', 26],
			['fable week', 0]
		]
	)
	// Asia/Bangkok is UTC+7: 1:29pm local = 06:29 UTC.
	assert.equal(new Date(windows[0]?.resetsAt ?? 0).toISOString(), '2026-09-25T06:29:00.000Z')
	assert.equal(
		new Date(parseClaudeReset('Jan 2, 9am (UTC)', NOW) ?? 0).toISOString(),
		'2027-01-02T09:00:00.000Z',
		'a date already past rolls into next year'
	)
})

test('claude: logged-out or missing CLI is hidden, logged-in reads /usage', async () => {
	const loggedIn = await getQuota(
		'anthropic',
		{
			...noPi,
			run: async (_command, args) =>
				args[0] === 'auth'
					? '{"loggedIn":true,"email":"c@x.com","subscriptionType":"team"}'
					: 'Current session: 5% used · resets Sep 25, 1:29pm (Asia/Bangkok)'
		},
		true
	)
	assert.equal(loggedIn?.quota?.plan, 'team')
	assert.equal(loggedIn?.quota?.windows[0]?.usedPercent, 5)
	const missing = await getQuota(
		'anthropic',
		{
			...noPi,
			run: async () => {
				throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
			}
		},
		true
	)
	assert.deepEqual([missing?.quota, missing?.error], [undefined, undefined])
})

test('deepseek balance flags an empty account', () => {
	const quota = parseDeepseekBalance({
		is_available: false,
		balance_infos: [{ currency: 'USD', total_balance: '0.00' }]
	})
	assert.equal(
		formatStatusLine('deepseek', quota),
		'deepseek api   balance $0.00   ⚠ insufficient balance'
	)
})

test('grok weekly pool; API key only shows api; nothing configured is hidden', async () => {
	const quota = parseGrokBilling(
		{ config: { creditUsagePercent: 42, currentPeriod: { end: '2026-09-23T14:13:20Z' } } },
		{ subscription_tier_display: 'SuperGrok' }
	)
	assert.equal(
		formatStatusLine('xai', quota, undefined, NOW),
		'grok supergrok   week ▰▰▰▱▱▱▱▱ 42% (2d0h)'
	)
	const keyOnly = await getQuota(
		'xai',
		{ ...noPi, getApiKeyForProvider: async () => 'xai-key', authSource: async () => 'XAI_API_KEY' },
		true
	)
	assert.equal(keyOnly?.quota?.plan, 'api')
	assert.equal((await getQuota('xai', noPi, true))?.quota, undefined)
})

test('readGrokLogin reads only an unexpired Grok CLI token', () => {
	const home = mkdtempSync(join(tmpdir(), 'usage-home-'))
	mkdirSync(join(home, '.grok'))
	writeFileSync(
		join(home, '.grok/auth.json'),
		JSON.stringify({
			a: { key: 'old', expires_at: new Date(NOW - 1).toISOString() },
			b: { key: 'grok-tok', expires_at: new Date(NOW + 60_000).toISOString(), email: 'g@x.ai' }
		})
	)
	assert.deepEqual(readGrokLogin(home, NOW), { token: 'grok-tok', account: 'g@x.ai' })
	assert.equal(readGrokLogin(join(home, 'missing'), NOW), undefined)
})

test('cursor plan and account come from cursor-agent about JSON', async () => {
	const result = await getQuota(
		'cursor',
		{
			...noPi,
			cliCommand: () => '/bin/cursor-agent',
			run: async (_command, args) =>
				args.includes('about') ? '{"subscriptionTier":"Pro","userEmail":"c@d.e"}' : ''
		},
		true
	)
	assert.equal(formatStatusLine('cursor', result?.quota ?? { windows: [] }), 'cursor pro   · c@d.e')
})

test('cursor dashboard usage: auto and API pools, limit message', () => {
	const usage = parseCursorUsage({
		billingCycleEnd: '1791814248000',
		planUsage: { autoPercentUsed: 100, apiPercentUsed: 40, totalPercentUsed: 100 },
		displayMessage: "You've hit your usage limit"
	})
	assert.deepEqual(
		usage.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]),
		[
			['auto month', 100, 1791814248000],
			['api month', 40, 1791814248000]
		]
	)
	assert.equal(usage.alert, "You've hit your usage limit")
})

test('agy /usage TSV becomes used-percent windows per model group', async () => {
	const tsv = [
		'Gemini Models\tWeekly Limit Remaining\t67%\t2026-09-30T09:03:10Z',
		'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-25T10:12:37Z',
		''
	].join('\n')
	assert.deepEqual(
		parseAgyUsage(tsv).windows.map((w) => [w.label, w.usedPercent]),
		[
			['gemini week', 33],
			['claude+gpt 5h', 0]
		]
	)
	const result = await getQuota(
		'antigravity',
		{
			...noPi,
			cliCommand: () => '/bin/agy',
			run: async (_command, args) => (args.join(' ') === '-p /usage' ? tsv : '')
		},
		true
	)
	assert.equal(result?.quota?.windows.length, 2)
})

test('renderReport: one block per provider, same head as the footer', () => {
	const report = renderReport(
		[
			{
				provider: 'openai-codex',
				active: true,
				result: {
					quota: {
						plan: 'plus',
						account: 'me@example.com',
						windows: [{ label: '5h', usedPercent: 50 }]
					}
				}
			},
			{ provider: 'deepseek', active: false, result: { error: 'HTTP 401' } }
		],
		undefined,
		NOW
	).join('\n')
	assert.match(report, /● codex plus me@example\.com · active\n {2}5h {4}━{20} {2}50%/)
	assert.match(report, /○ deepseek\n {2}! {5}unavailable: HTTP 401/)
	assert.match(renderReport([]).join('\n'), /No signed-in providers detected/)
})

test('quotaExhausted: every pool spent, not just one window', () => {
	const w = (label: string, usedPercent: number) => ({ label, usedPercent })
	assert.equal(quotaExhausted({ windows: [w('auto month', 100), w('api month', 100)] }), true)
	assert.equal(quotaExhausted({ windows: [w('auto month', 100), w('api month', 40)] }), false)
	assert.equal(
		quotaExhausted({ windows: [w('gemini week', 33), w('claude+gpt week', 100)] }),
		false,
		'gemini still has quota'
	)
	assert.equal(quotaExhausted({ windows: [w('5h', 20), w('week', 100)] }), true)
	assert.equal(quotaExhausted({ windows: [] }), false)
})

test('formatDuration', () => {
	assert.equal(formatDuration(-1), 'now')
	assert.equal(formatDuration(45 * 60_000), '45m')
	assert.equal(formatDuration(26 * 3_600_000), '1d2h')
})
