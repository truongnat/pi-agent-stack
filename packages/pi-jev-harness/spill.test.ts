import assert from 'node:assert/strict'
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { pruneSpills, spill, spillHint } from './spill.ts'

void test('spill keeps the full output in an owner-only file and points the model to it', () => {
	const dir = join(mkdtempSync(join(tmpdir(), 'spill-')), 'spill')
	const path = spill('x'.repeat(10_000), 'bash', dir)
	assert.ok(path)
	assert.equal(readFileSync(path, 'utf8').length, 10_000)
	assert.equal(statSync(path).mode & 0o777, 0o600)
	assert.equal(statSync(dir).mode & 0o777, 0o700)
	assert.match(spillHint(path), /read tool \(offset\/limit\) or grep/)
})

void test('spill failure returns undefined so the caller keeps its message', () => {
	const file = join(mkdtempSync(join(tmpdir(), 'spill-')), 'not-a-dir')
	writeFileSync(file, '')
	assert.equal(spill('text', 'bash', file), undefined)
})

void test('pruneSpills removes files past the retention window', () => {
	const dir = mkdtempSync(join(tmpdir(), 'spill-'))
	const old = join(dir, 'old.txt')
	const fresh = join(dir, 'fresh.txt')
	writeFileSync(old, 'a')
	writeFileSync(fresh, 'b')
	const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000
	utimesSync(old, twoDaysAgo, twoDaysAgo)
	pruneSpills(dir)
	assert.deepEqual(readdirSync(dir), ['fresh.txt'])
})
