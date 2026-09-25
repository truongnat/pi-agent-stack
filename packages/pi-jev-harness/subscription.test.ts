import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
	freshSubscriptionProviders,
	needsForcedSubscriptionExit,
	readSubscriptionStatus,
	redactSubscriptionLog,
	subscriptionAllowedForKind,
	type SubscriptionStatus
} from './subscription.ts'

void test('JEV skips unavailable subscription providers', () => {
	const status: SubscriptionStatus = {
		updatedAt: Date.now(),
		cursor: {
			provider: 'cursor',
			ready: false,
			reason: 'unauthenticated',
			billingMode: 'subscription',
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		},
		antigravity: {
			provider: 'antigravity',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			quotaAvailable: true,
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [{ id: 'gemini-3.7-flash-high', name: 'Gemini', reasoning: true }],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		}
	}
	const ready = freshSubscriptionProviders(status)
	assert.equal(ready.length, 1)
	assert.equal(ready[0]?.provider, 'antigravity')
})

void test('JEV skips subscription providers with exhausted quota', () => {
	const status: SubscriptionStatus = {
		updatedAt: Date.now(),
		cursor: {
			provider: 'cursor',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			quotaAvailable: false,
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [{ id: 'auto', name: 'Auto', reasoning: false }],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		},
		antigravity: {
			provider: 'antigravity',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			quotaAvailable: true,
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [{ id: 'gemini', name: 'Gemini', reasoning: true }],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		}
	}
	const ready = freshSubscriptionProviders(status)
	assert.equal(ready.length, 1)
	assert.equal(ready[0]?.provider, 'antigravity')
})

void test('subscription allowed only for answer turns', () => {
	assert.equal(subscriptionAllowedForKind('answer'), true)
	assert.equal(subscriptionAllowedForKind('explore'), false)
	assert.equal(subscriptionAllowedForKind('change'), false)
	assert.equal(subscriptionAllowedForKind('run'), false)
	assert.equal(subscriptionAllowedForKind('unclear'), false)
})

void test('forced subscription exit when current is cursor/antigravity on tool turns', () => {
	assert.equal(needsForcedSubscriptionExit('change', 'cursor'), true)
	assert.equal(needsForcedSubscriptionExit('run', 'antigravity'), true)
	assert.equal(needsForcedSubscriptionExit('explore', 'cursor'), true)
	assert.equal(needsForcedSubscriptionExit('answer', 'cursor'), false)
	assert.equal(needsForcedSubscriptionExit('change', 'openai-codex'), false)
	assert.equal(needsForcedSubscriptionExit('answer', 'openai-codex'), false)
})

void test('JEV prefers cheapest sufficient path metadata ordering', () => {
	const status: SubscriptionStatus = {
		updatedAt: Date.now(),
		cursor: {
			provider: 'cursor',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			quotaAvailable: true,
			latencyEstimateMs: 12_000,
			marginalInputCost: 0.1,
			marginalOutputCost: 0.4,
			models: [{ id: 'auto', name: 'Auto', reasoning: false }],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		},
		antigravity: {
			provider: 'antigravity',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			quotaAvailable: true,
			latencyEstimateMs: 6_000,
			marginalInputCost: 0.2,
			marginalOutputCost: 0.8,
			models: [{ id: 'gemini', name: 'Gemini', reasoning: true }],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		}
	}
	const ready = freshSubscriptionProviders(status)
	const sorted = [...ready].sort(
		(a, b) =>
			a.marginalInputCost + a.marginalOutputCost - (b.marginalInputCost + b.marginalOutputCost)
	)
	assert.equal(sorted[0]?.provider, 'cursor')
})

void test('subscription status read + secret redaction', () => {
	const dir = mkdtempSync(join(tmpdir(), 'jev-sub-'))
	const path = join(dir, 'status.json')
	const payload: SubscriptionStatus = {
		updatedAt: Date.now(),
		cursor: {
			provider: 'cursor',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [{ id: 'auto', name: 'Auto', reasoning: false }],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		},
		antigravity: {
			provider: 'antigravity',
			ready: false,
			reason: 'missing',
			billingMode: 'subscription',
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [],
			checkedAt: Date.now(),
			toolMode: 'compatibility'
		}
	}
	writeFileSync(path, JSON.stringify(payload))
	const loaded = readSubscriptionStatus(path)
	assert.equal(loaded?.cursor.ready, true)
	const redacted = redactSubscriptionLog({
		email: 'user@example.com',
		token: 'secret',
		choice: 'cursor/auto',
		note: 'Bearer abc.def user@example.com'
	})
	assert.equal(redacted.email, undefined)
	assert.equal(redacted.token, undefined)
	assert.equal(redacted.choice, 'cursor/auto')
	assert.ok(String(redacted.note).includes('[REDACTED]'))
})

void test('stale subscription status is ignored', () => {
	const status: SubscriptionStatus = {
		updatedAt: 0,
		cursor: {
			provider: 'cursor',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [{ id: 'auto', name: 'Auto', reasoning: false }],
			checkedAt: Date.now() - 60 * 60_000,
			toolMode: 'compatibility'
		},
		antigravity: {
			provider: 'antigravity',
			ready: true,
			reason: 'ready',
			billingMode: 'subscription',
			latencyEstimateMs: 1000,
			marginalInputCost: 0.15,
			marginalOutputCost: 0.6,
			models: [{ id: 'g', name: 'G', reasoning: false }],
			checkedAt: Date.now() - 60 * 60_000,
			toolMode: 'compatibility'
		}
	}
	assert.equal(freshSubscriptionProviders(status, Date.now(), 5 * 60_000).length, 0)
})

void test('claude-code is a subscription provider; old status files without it still load', () => {
	const row = (provider: 'cursor' | 'antigravity' | 'claude-code', ready: boolean) => ({
		provider,
		ready,
		reason: ready ? 'ready' : 'missing',
		billingMode: 'subscription' as const,
		quotaAvailable: true,
		latencyEstimateMs: 1000,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [],
		checkedAt: Date.now(),
		toolMode: 'compatibility' as const
	})
	const legacy: SubscriptionStatus = {
		updatedAt: Date.now(),
		cursor: row('cursor', false),
		antigravity: row('antigravity', false)
	}
	assert.deepEqual(freshSubscriptionProviders(legacy), [])
	const withClaude: SubscriptionStatus = { ...legacy, 'claude-code': row('claude-code', true) }
	assert.deepEqual(
		freshSubscriptionProviders(withClaude).map((r) => r.provider),
		['claude-code']
	)
	assert.equal(needsForcedSubscriptionExit('change', 'claude-code'), true)
	assert.equal(needsForcedSubscriptionExit('answer', 'claude-code'), false)
})

void test('automatic() marks JEV changes until the events they trigger have run', async () => {
	const { automatic } = await import('./model-route.ts')
	let seenDuring = 0
	await automatic(async () => {
		seenDuring = globalThis.piAgentStackAutomaticChange ?? 0
	})
	assert.equal(seenDuring, 1)
	assert.equal(globalThis.piAgentStackAutomaticChange, 1, 'still marked right after the call')
	await new Promise((resolve) => setTimeout(resolve, 5))
	assert.equal(globalThis.piAgentStackAutomaticChange, 0, 'cleared on the next macrotask')
})
