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

test('applySkeletonize replaces bulky read_file bodies with signatures', async () => {
	const { applySkeletonize } = await import('../lib/strategies/skeletonize.ts')
	const body = Array.from(
		{ length: 40 },
		(_, i) => `	acc += ${i} * factor;\n	if (acc > 10) acc = acc / 2;\n`
	).join('')
	const source = `export function heavyProcessor(input: { id: string }, factor: number): number {\n${body}\n	return acc;\n}\n`
	const messages: any[] = [
		{
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: 'r1',
					name: 'read_file',
					arguments: { path: 'src/heavy.ts' }
				}
			]
		},
		{
			role: 'toolResult',
			toolCallId: 'r1',
			toolName: 'read_file',
			content: [{ type: 'text', text: source }],
			isError: false
		}
	]
	const state = createSessionState()
	const result = applySkeletonize(messages, DEFAULT_CONFIG, state)
	assert.ok(result.skeletonizedCount === 1 || source.length < 800)
	if (result.skeletonizedCount === 1) {
		const text = messages[1].content[0].text as string
		assert.match(text, /skeleton by pi-dcp/)
		assert.match(text, /heavyProcessor/)
		assert.ok(!text.includes('acc += 12'))
	}
})
