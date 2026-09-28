import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeJsonl, summarizeJsonEvent, textFromMessageContent } from '../src/json-stream.ts'

test('consumeJsonl splits complete records and keeps a partial line', () => {
	const seen: unknown[] = []
	const rest = consumeJsonl('{"type":"a"}\n{"type":"b"}\n{"type":"c', (o) => seen.push(o))
	assert.deepEqual(seen, [{ type: 'a' }, { type: 'b' }])
	assert.equal(rest, '{"type":"c')
})

test('summarizeJsonEvent maps thinking, text, and tools to activity lines', () => {
	assert.equal(
		summarizeJsonEvent({
			type: 'message_update',
			assistantMessageEvent: { type: 'thinking_delta', delta: 'and' }
		}).activity,
		undefined
	)
	assert.equal(
		summarizeJsonEvent({
			type: 'message_update',
			assistantMessageEvent: {
				type: 'thinking_delta',
				delta: '**Planning baseline inspection approach**'
			}
		}).activity,
		'💭 **Planning baseline inspection approach**'
	)
	const textDelta = summarizeJsonEvent({
		type: 'message_update',
		assistantMessageEvent: { type: 'text_delta', delta: 'Implementing radio keys' }
	})
	assert.equal(textDelta.activity, undefined)
	assert.equal(textDelta.assistantDelta, 'Implementing radio keys')
	assert.match(
		summarizeJsonEvent({
			type: 'tool_execution_start',
			toolName: 'read',
			args: { path: 'crates/ui/src/radio.rs' }
		}).activity || '',
		/▶ `read`/
	)
	assert.equal(
		summarizeJsonEvent({
			type: 'tool_execution_end',
			toolName: 'edit',
			isError: false
		}).activity,
		'✓ `edit`'
	)
	assert.equal(
		summarizeJsonEvent({
			type: 'tool_execution_end',
			toolName: 'read',
			isError: true
		}).activity,
		'✖ `read` failed'
	)
})

test('message_end assistant content becomes final text', () => {
	const s = summarizeJsonEvent({
		type: 'message_end',
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: 'Done with keyboard nav.' }]
		}
	})
	assert.equal(s.assistantFinal, 'Done with keyboard nav.')
	assert.equal(
		textFromMessageContent([
			{ type: 'text', text: 'a' },
			{ type: 'text', text: 'b' }
		]),
		'ab'
	)
})
