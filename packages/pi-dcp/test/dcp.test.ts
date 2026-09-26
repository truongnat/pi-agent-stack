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
