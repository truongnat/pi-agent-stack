import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TranscriptContext } from '@earendil-works/pi-ai'

import { DEFAULT_CONFIG } from '../src/config.ts'
import {
	checkAntigravityReadiness,
	checkClaudeCodeReadiness,
	checkCursorReadiness
} from '../src/readiness.ts'
import { redact } from '../src/redact.ts'
import { streamAntigravityCli, streamClaudeCodeCli, streamCursorCli } from '../src/stream.ts'
import type { Readiness, Runner } from '../src/types.ts'

function fakeContext(): TranscriptContext {
	// SAFETY: tests only need messages; brand is runtime-opaque.
	return {
		messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }]
	} as unknown as TranscriptContext
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
			step_update: { step_type: 'agent_response', thinking_delta: 'analyzing...', state: 'ACTIVE' }
		}),
		JSON.stringify({
			event: 'step_update',
			step_update: { step_type: 'agent_response', text_delta: 'pong', state: 'DONE' }
		}),
		JSON.stringify({
			event: 'result',
			result: {
				status: 'SUCCESS',
				response: 'pong',
				usage: { input_tokens: 5, output_tokens: 1, thinking_tokens: 2, cache_read_tokens: 0 }
			}
		})
	]
	let capturedStdin: string | Buffer | undefined
	const stream = streamAntigravityCli(model, fakeContext(), {}, readiness, async (req) => {
		capturedStdin = req.stdin
		for (const line of lines) req.onLine(line)
		return { code: 0, timedOut: false, aborted: false, stderr: '' }
	})
	const events = []
	for await (const event of stream) events.push(event)
	assert.ok(
		events.some((event) => event.type === 'thinking_delta' && event.delta === 'analyzing...')
	)
	assert.ok(events.some((event) => event.type === 'text_delta' && event.delta === 'pong'))
	assert.ok(events.some((event) => event.type === 'done'))
	// Short prompts go through -p, not stdin.
	assert.equal(capturedStdin, undefined)
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

test('buildCliPrompt bounds prompt size for long conversations to prevent spawn E2BIG', async () => {
	const { buildCliPrompt, MAX_CLI_PROMPT_CHARS } = await import('../src/transcript.ts')
	const longMessages = []
	for (let i = 0; i < 200; i++) {
		longMessages.push({
			role: 'user' as const,
			content: `Message ${i}: ${'x'.repeat(1000)}`,
			timestamp: Date.now()
		})
		longMessages.push({
			role: 'assistant' as const,
			content: [{ type: 'text' as const, text: `Reply ${i}: ${'y'.repeat(1000)}` }],
			timestamp: Date.now()
		})
	}
	// SAFETY: fixture assistant messages omit api/provider/usage, which buildCliPrompt never reads.
	const context = {
		systemPrompt: 'You are an AI assistant.'.repeat(100),
		messages: longMessages
	} as unknown as TranscriptContext
	const prompt = buildCliPrompt(context)
	assert.ok(
		prompt.length <= MAX_CLI_PROMPT_CHARS,
		`Prompt length ${prompt.length} exceeds max ${MAX_CLI_PROMPT_CHARS}`
	)
	assert.ok(prompt.includes('[... earlier conversation truncated for CLI compatibility ...]'))
	assert.ok(prompt.includes('Message 199'))
})

test('claude-code stream: text/thinking deltas, usage, prompt on stdin, tools off', async () => {
	const readiness: Readiness = {
		provider: 'claude-code',
		ready: true,
		reason: 'ready',
		command: '/bin/claude',
		billingMode: 'subscription',
		latencyEstimateMs: 1000,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [{ id: 'haiku', name: 'Haiku', reasoning: false }],
		checkedAt: Date.now(),
		toolMode: 'compatibility'
	}
	const model = {
		id: 'haiku',
		name: 'Haiku',
		api: 'claude-code-cli-compat',
		provider: 'claude-code',
		baseUrl: 'cli://claude',
		reasoning: false,
		input: ['text'] as ('text' | 'image')[],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192
	}
	const delta = (d: object) =>
		JSON.stringify({
			type: 'stream_event',
			event: { type: 'content_block_delta', index: 0, delta: d }
		})
	const lines = [
		JSON.stringify({ type: 'system', subtype: 'init' }),
		delta({ type: 'thinking_delta', thinking: 'hmm' }),
		delta({ type: 'text_delta', text: 'po' }),
		delta({ type: 'text_delta', text: 'ng' }),
		JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'pong',
			usage: {
				input_tokens: 10,
				output_tokens: 2,
				cache_read_input_tokens: 5,
				cache_creation_input_tokens: 7
			}
		})
	]
	let seen: { args: string[]; stdin?: string | Buffer | undefined } | undefined
	const stream = streamClaudeCodeCli(model, fakeContext(), {}, readiness, async (req) => {
		seen = { args: req.args, stdin: req.stdin }
		for (const line of lines) req.onLine(line)
		return { code: 0, timedOut: false, aborted: false, stderr: '' }
	})
	const events = []
	for await (const event of stream) events.push(event)
	const done = events.find((e) => e.type === 'done')
	assert.ok(done && done.type === 'done')
	const text = done.message.content.find((c) => c.type === 'text')
	assert.equal(text?.type === 'text' ? text.text : '', 'pong', 'deltas only; result not duplicated')
	assert.deepEqual(
		[
			done.message.usage.input,
			done.message.usage.output,
			done.message.usage.cacheRead,
			done.message.usage.cacheWrite
		],
		[10, 2, 5, 7]
	)
	assert.ok(events.some((e) => e.type === 'thinking_delta'))
	assert.ok(seen?.args.includes('--no-session-persistence'))
	assert.equal(seen?.args[seen.args.indexOf('--tools') + 1], '', 'tools disabled')
	assert.match(String(seen?.stdin), /hi/, 'prompt goes through stdin')
})

test('claude-code readiness: logged in vs logged out', async () => {
	const runnerFor =
		(stdout: string, code = 0): Runner =>
		async () => ({ code, stdout, stderr: '', timedOut: false, aborted: false, durationMs: 1 })
	const config = {
		...DEFAULT_CONFIG,
		'claude-code': { ...DEFAULT_CONFIG['claude-code'], command: 'sh' }
	}
	const ready = await checkClaudeCodeReadiness(config, runnerFor('{"loggedIn":true}'))
	assert.equal(ready.ready, true)
	assert.deepEqual(
		ready.models.map((m) => m.id),
		['sonnet', 'opus', 'haiku']
	)
	const out = await checkClaudeCodeReadiness(config, runnerFor('{"loggedIn":false}', 1))
	assert.equal(out.ready, false)
	assert.match(out.reason, /not logged in/)
})
