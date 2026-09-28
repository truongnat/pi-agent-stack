import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG, loadConfig } from '../lib/config.ts'
import { createSessionState } from '../lib/state.ts'
import { applyDeduplication } from '../lib/strategies/deduplication.ts'

test('loadConfig returns default configuration when empty', () => {
	const config = loadConfig(process.cwd())
	assert.ok(config)
	assert.equal(config.enabled, true)
	assert.ok(config.strategies.deduplication.enabled)
	assert.ok(config.strategies.purgeErrors.enabled)
})

test('applyDeduplication replaces older duplicate tool calls', () => {
	const messages: any[] = [
		{
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: 'call_1',
					name: 'read_file',
					arguments: { path: '/src/index.ts' }
				}
			]
		},
		{
			role: 'toolResult',
			toolCallId: 'call_1',
			content: [{ type: 'text', text: 'file content v1' }]
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: 'call_2',
					name: 'read_file',
					arguments: { path: '/src/index.ts' }
				}
			]
		},
		{
			role: 'toolResult',
			toolCallId: 'call_2',
			content: [{ type: 'text', text: 'file content v2' }]
		}
	]

	const state = createSessionState()
	const result = applyDeduplication(messages, DEFAULT_CONFIG, state)

	assert.ok(result)
	assert.equal(result.prunedCount, 1)
	// First tool result should be pruned
	const firstResultText = JSON.stringify(messages[1].content)
	assert.match(firstResultText, /pruned by pi-dcp/i)
	// Second tool result should remain intact
	const secondResultText = JSON.stringify(messages[3].content)
	assert.match(secondResultText, /file content v2/)
})

test('applySkeletonize shrinks older reads, keeps the latest read whole, counts once', async () => {
	const { applySkeletonize } = await import('../lib/strategies/skeletonize.ts')
	const body = Array.from(
		{ length: 40 },
		(_, i) => `	acc += ${i} * factor;\n	if (acc > 10) acc = acc / 2;\n`
	).join('')
	const source = `export function heavyProcessor(input: { id: string }, factor: number): number {\n${body}\n	return acc;\n}\n`
	const read = (id: string) => [
		{
			role: 'assistant',
			content: [{ type: 'toolCall', id, name: 'read_file', arguments: { path: 'src/heavy.ts' } }]
		},
		{
			role: 'toolResult',
			toolCallId: id,
			toolName: 'read_file',
			content: [{ type: 'text', text: source }],
			isError: false
		}
	]
	const fresh = () => [...read('r1'), ...read('r2')] as any[]
	const state = createSessionState()
	const messages = fresh()
	const result = applySkeletonize(messages, DEFAULT_CONFIG, state)
	assert.equal(result.skeletonizedCount, 1)
	const older = messages[1].content[0].text as string
	assert.match(older, /skeleton by pi-dcp/)
	assert.match(older, /heavyProcessor/)
	assert.ok(!older.includes('acc += 12'))
	assert.equal(messages[3].content[0].text, source, 'latest read stays whole for edits')

	// Every pipeline pass starts from the originals; the rewrite repeats, the stats do not.
	assert.equal(applySkeletonize(fresh(), DEFAULT_CONFIG, state).skeletonizedCount, 0)
})

test('a user-set global compress limit beats the built-in per-model limits', async () => {
	const { mergeConfig, resolveModelLimit } = await import('../lib/config.ts')
	const opus = { provider: 'anthropic', id: 'claude-opus-4-7' }
	const builtIn = mergeConfig(null, null)
	assert.equal(
		resolveModelLimit(
			builtIn.compress.maxContextLimit,
			builtIn.compress.modelMaxLimits,
			opus,
			1_000_000
		),
		85_000
	)
	const user = mergeConfig({ compress: { maxContextLimit: '70%' } } as never, null)
	assert.equal(
		resolveModelLimit(user.compress.maxContextLimit, user.compress.modelMaxLimits, opus, 1_000_000),
		700_000
	)
	const explicit = mergeConfig(
		{
			compress: { maxContextLimit: '70%', modelMaxLimits: { 'anthropic/claude-opus-4-7': 90_000 } }
		} as never,
		null
	)
	assert.equal(
		resolveModelLimit(
			explicit.compress.maxContextLimit,
			explicit.compress.modelMaxLimits,
			opus,
			1_000_000
		),
		90_000
	)
})

test('/dcp sweep compressions apply inside the protected recent turns', async () => {
	const { runPipeline } = await import('../lib/pipeline.ts')
	const { Logger } = await import('../lib/logger.ts')
	const messages: any[] = [
		{ role: 'user', content: 'check the logs' },
		{
			role: 'assistant',
			content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'cat big.log' } }]
		},
		{
			role: 'toolResult',
			toolCallId: 'b1',
			toolName: 'bash',
			content: [{ type: 'text', text: 'x'.repeat(5000) }],
			isError: false
		}
	]
	const state = createSessionState()
	const base = {
		id: 1,
		createdAt: 0,
		toolCallIds: ['b1'],
		summary: '',
		topic: 'manual sweep',
		tokensSaved: 0,
		suspended: false
	}
	state.compressions.set(1, { ...base })
	const kept = runPipeline(messages, DEFAULT_CONFIG, state, new Logger(false))
	assert.equal(kept.compressionsApplied, 0, 'model compress stays out of recent turns')

	const swept = createSessionState()
	swept.compressions.set(1, { ...base, manual: true })
	const result = runPipeline(messages, DEFAULT_CONFIG, swept, new Logger(false))
	assert.equal(result.compressionsApplied, 1)
	assert.ok(!JSON.stringify(result.messages[2]).includes('xxxxxxxxxx'))
})
