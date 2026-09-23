import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TranscriptContext } from '@earendil-works/pi-ai'

import { DEFAULT_CONFIG } from '../src/config.ts'
import { checkAntigravityReadiness, checkCursorReadiness } from '../src/readiness.ts'
import { redact } from '../src/redact.ts'
import { streamAntigravityCli, streamCursorCli } from '../src/stream.ts'
import type { Readiness, Runner } from '../src/types.ts'

function fakeContext(): TranscriptContext {
	// SAFETY: tests only need messages; brand is runtime-opaque.
	return {
		messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }]
	} as TranscriptContext
}

function mockRunner(
	handlers: Record<string, { code?: number; stdout?: string; stderr?: string }>
): Runner {
	return async ({ command, args }) => {
		const key = `${command} ${args.join(' ')}`
		for (const [pattern, response] of Object.entries(handlers)) {
			if (key.includes(pattern) || pattern === '*') {
				return {
					code: response.code ?? 0,
					stdout: response.stdout ?? '',
					stderr: response.stderr ?? '',
					timedOut: false,
					aborted: false,
					durationMs: 1
				}
			}
		}
		return {
			code: 127,
			stdout: '',
			stderr: 'not found',
			timedOut: false,
			aborted: false,
			durationMs: 1
		}
	}
}

test('redact removes emails and tokens', () => {
	const text = redact('user@example.com Bearer abc.def KEY=sk-abcdefghi123456789')
	assert.ok(!text.includes('user@example.com'))
	assert.ok(!text.includes('sk-abcdefghi'))
	assert.ok(text.includes('[REDACTED]'))
})

test('cursor CLI unavailable', async () => {
	const runner = mockRunner({
		'--help': { code: 127, stderr: 'not found' }
	})
	const config = {
		...DEFAULT_CONFIG,
		cursor: { ...DEFAULT_CONFIG.cursor, command: '/missing/cursor-agent' }
	}
	const readiness = await checkCursorReadiness(config, runner)
	assert.equal(readiness.ready, false)
	assert.match(readiness.reason, /not found|not Cursor/i)
})

test('cursor CLI unauthenticated', async () => {
	const runner: Runner = async ({ args }) => {
		if (args.includes('--help')) {
			return {
				code: 0,
				stdout: 'Usage: agent\nCursor Agent\n--list-models\nstream-json\n',
				stderr: '',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		if (args.includes('status')) {
			return {
				code: 1,
				stdout: '',
				stderr: 'Not logged in. Run agent login.',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		return {
			code: 1,
			stdout: '',
			stderr: 'fail',
			timedOut: false,
			aborted: false,
			durationMs: 1
		}
	}
	const config = {
		...DEFAULT_CONFIG,
		cursor: { ...DEFAULT_CONFIG.cursor, command: '/bin/cursor-agent' }
	}
	const readiness = await checkCursorReadiness(config, runner)
	assert.equal(readiness.ready, false)
	assert.match(readiness.reason, /unauthenticated/i)
	assert.ok(!readiness.reason.includes('@'))
})

test('cursor CLI authenticated with mocked models', async () => {
	const runner: Runner = async ({ args }) => {
		if (args.includes('--help')) {
			return {
				code: 0,
				stdout: 'Cursor Agent\n--list-models\nstream-json\n',
				stderr: '',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		if (args.includes('status')) {
			return {
				code: 0,
				stdout: '✓ Logged in as user@example.com',
				stderr: '',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		if (args.includes('models')) {
			return {
				code: 0,
				stdout: 'Available models\nauto - Auto\ngpt-5.2 - GPT-5.2\n',
				stderr: '',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		return {
			code: 1,
			stdout: '',
			stderr: 'unexpected',
			timedOut: false,
			aborted: false,
			durationMs: 1
		}
	}
	const config = {
		...DEFAULT_CONFIG,
		cursor: { ...DEFAULT_CONFIG.cursor, command: '/bin/cursor-agent' }
	}
	const readiness = await checkCursorReadiness(config, runner)
	assert.equal(readiness.ready, true)
	assert.equal(readiness.models.length >= 1, true)
	assert.equal(readiness.billingMode, 'subscription')
	assert.ok(readiness.marginalInputCost > 0)
})

test('antigravity CLI unavailable', async () => {
	const config = {
		...DEFAULT_CONFIG,
		antigravity: { ...DEFAULT_CONFIG.antigravity, command: '/missing/agy' }
	}
	const readiness = await checkAntigravityReadiness(
		config,
		mockRunner({ '--help': { code: 127, stderr: 'missing' } })
	)
	assert.equal(readiness.ready, false)
})

test('antigravity ACP binary is not marked ready without ACP adapter', async () => {
	const runner: Runner = async ({ args }) => {
		if (args.includes('--help')) {
			return {
				code: 0,
				stdout: 'Start Antigravity in ACP mode\nagent client protocol\n',
				stderr: '',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		return {
			code: 1,
			stdout: '',
			stderr: 'unexpected',
			timedOut: false,
			aborted: false,
			durationMs: 1
		}
	}
	const config = {
		...DEFAULT_CONFIG,
		antigravity: { ...DEFAULT_CONFIG.antigravity, command: '/bin/agy-acp' }
	}
	const readiness = await checkAntigravityReadiness(config, runner)
	assert.equal(readiness.ready, false)
	assert.match(readiness.reason, /ACP stream adapter is not implemented/i)
})

test('antigravity agy mocked models ready', async () => {
	const runner: Runner = async ({ args }) => {
		if (args.includes('--help')) {
			return {
				code: 0,
				stdout: 'Usage of agy:\n--output-format\nstream-json\n',
				stderr: '',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		if (args.includes('models')) {
			return {
				code: 0,
				stdout: 'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n',
				stderr: '',
				timedOut: false,
				aborted: false,
				durationMs: 1
			}
		}
		return {
			code: 1,
			stdout: '',
			stderr: 'unexpected',
			timedOut: false,
			aborted: false,
			durationMs: 1
		}
	}
	const config = {
		...DEFAULT_CONFIG,
		antigravity: { ...DEFAULT_CONFIG.antigravity, command: '/bin/agy' }
	}
	const readiness = await checkAntigravityReadiness(config, runner)
	assert.equal(readiness.ready, true)
	assert.equal(readiness.models[0]?.id, 'gemini-3.7-flash-high')
})

test('cursor stream parses mocked NDJSON and redacts errors', async () => {
	const readiness: Readiness = {
		provider: 'cursor',
		ready: true,
		reason: 'ready',
		command: '/bin/cursor-agent',
		billingMode: 'subscription',
		latencyEstimateMs: 1000,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [{ id: 'auto', name: 'Auto', reasoning: false }],
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
	const model = {
		id: 'auto',
		name: 'Auto',
		api: 'cursor-cli-compat',
		provider: 'cursor',
		baseUrl: 'cli://cursor',
		reasoning: false,
		input: ['text'] as ('text' | 'image')[],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8192
	}
	const lines = [
		JSON.stringify({
			type: 'thinking',
			subtype: 'delta',
			text: 'plan'
		}),
		JSON.stringify({
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] }
		}),
		JSON.stringify({
			type: 'result',
			subtype: 'success',
			result: 'pong',
			usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
		})
	]
	const stream = streamCursorCli(model, fakeContext(), {}, readiness, async ({ onLine }) => {
		for (const line of lines) onLine(line)
		return { code: 0, timedOut: false, aborted: false, stderr: '' }
	})
	const events = []
	for await (const event of stream) events.push(event)
	const done = events.find((event) => event.type === 'done')
	assert.ok(done)
	assert.equal(done.type, 'done')
	if (done.type === 'done') {
		assert.equal(done.message.stopReason, 'stop')
		assert.ok(JSON.stringify(done.message).includes('pong'))
	}
})

test('antigravity stream parses mocked events', async () => {
	const readiness: Readiness = {
		provider: 'antigravity',
		ready: true,
		reason: 'ready',
		command: '/bin/agy',
		billingMode: 'subscription',
		latencyEstimateMs: 1000,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [{ id: 'gemini-3.7-flash-high', name: 'Gemini', reasoning: true }],
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
	const model = {
		id: 'gemini-3.7-flash-high',
		name: 'Gemini',
		api: 'antigravity-cli-compat',
		provider: 'antigravity',
		baseUrl: 'cli://agy',
		reasoning: true,
		input: ['text'] as ('text' | 'image')[],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8192
	}
	const lines = [
		JSON.stringify({
			event: 'step_update',
			step_update: { step_type: 'agent_response', text_delta: 'pong', state: 'DONE' }
		}),
		JSON.stringify({
			event: 'result',
			result: {
				status: 'SUCCESS',
				response: 'pong',
				usage: { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0 }
			}
		})
	]
	const stream = streamAntigravityCli(model, fakeContext(), {}, readiness, async ({ onLine }) => {
		for (const line of lines) onLine(line)
		return { code: 0, timedOut: false, aborted: false, stderr: '' }
	})
	const events = []
	for await (const event of stream) events.push(event)
	assert.ok(events.some((event) => event.type === 'done'))
})

test('timeout and cancellation map to structured errors', async () => {
	const readiness: Readiness = {
		provider: 'cursor',
		ready: true,
		reason: 'ready',
		command: '/bin/cursor-agent',
		billingMode: 'subscription',
		latencyEstimateMs: 1000,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [{ id: 'auto', name: 'Auto', reasoning: false }],
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
	const model = {
		id: 'auto',
		name: 'Auto',
		api: 'cursor-cli-compat',
		provider: 'cursor',
		baseUrl: 'cli://cursor',
		reasoning: false,
		input: ['text'] as ('text' | 'image')[],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8192
	}
	const stream = streamCursorCli(model, fakeContext(), {}, readiness, async () => ({
		code: 0,
		timedOut: true,
		aborted: false,
		stderr: ''
	}))
	const events = []
	for await (const event of stream) events.push(event)
	const err = events.find((event) => event.type === 'error')
	assert.ok(err)
	if (err?.type === 'error') {
		assert.match(err.error.errorMessage ?? '', /timed out/i)
		assert.ok(!(err.error.errorMessage ?? '').includes('sk-'))
	}
})

test('provider_not_ready when command missing', async () => {
	const readiness: Readiness = {
		provider: 'cursor',
		ready: false,
		reason: 'Cursor Agent CLI not found',
		billingMode: 'subscription',
		latencyEstimateMs: 1000,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [],
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
	const model = {
		id: 'auto',
		name: 'Auto',
		api: 'cursor-cli-compat',
		provider: 'cursor',
		baseUrl: 'cli://cursor',
		reasoning: false,
		input: ['text'] as ('text' | 'image')[],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8192
	}
	const stream = streamCursorCli(model, fakeContext(), {}, readiness)
	const events = []
	for await (const event of stream) events.push(event)
	const err = events.find((event) => event.type === 'error')
	assert.ok(err)
	if (err?.type === 'error') assert.match(err.error.errorMessage ?? '', /provider_not_ready/)
})

test('offline refreshModels returns snapshot without CLI probe', async () => {
	const { modelsFromSnapshot, refreshProviderModels } = await import('../src/extension.ts')
	const started = performance.now()
	const offline = await refreshProviderModels('cursor', { allowNetwork: false })
	const elapsed = performance.now() - started
	assert.deepEqual(offline, modelsFromSnapshot('cursor', null))
	// Offline path must not wait on CLI probes (status/models take seconds).
	assert.ok(elapsed < 200, `offline refresh took ${elapsed}ms`)
})
