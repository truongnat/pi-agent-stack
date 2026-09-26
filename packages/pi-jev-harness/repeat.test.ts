import assert from 'node:assert/strict'
import { test } from 'node:test'

import { callKey, repeatReminder } from './tools.ts'

void test('input key order does not make a repeated call look new', () => {
	assert.equal(
		callKey('grep', { pattern: 'x', path: 'src' }),
		callKey('grep', { path: 'src', pattern: 'x' })
	)
	assert.notEqual(callKey('grep', { pattern: 'x' }), callKey('grep', { pattern: 'y' }))
	assert.equal(callKey('t', { a: [{ z: 1, y: 2 }] }), callKey('t', { a: [{ y: 2, z: 1 }] }))
})

void test('reminders fire at 3, 5 and 8 repeats only', () => {
	const fired = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => repeatReminder('bash', n))
	assert.deepEqual(fired, [3, 5, 8])
	assert.match(repeatReminder('bash', 5) ?? '', /5 identical bash calls detected/)
	assert.match(repeatReminder('edit', 3, 'src/auth.ts') ?? '', /src\/auth\.ts/)
})

void test('callKey differentiates edits to different files and normalizes object keys', () => {
	const key1 = callKey('edit', { path: 'a.ts', line: 10 })
	const key2 = callKey('edit', { line: 10, path: 'a.ts' })
	const key3 = callKey('edit', { path: 'b.ts', line: 10 })
	assert.equal(key1, key2)
	assert.notEqual(key1, key3)
})
