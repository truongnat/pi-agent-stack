import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runStreamingLines } from '../src/line-stream.ts'
import { defaultRunner } from '../src/subprocess.ts'

const big = 'x'.repeat(2_000_000)
const base = { timeoutMs: 10_000, maxOutputChars: 100_000 }

void test('a CLI that exits before reading stdin reports its exit code instead of crashing on EPIPE', async () => {
	const lines = await runStreamingLines({
		...base,
		command: 'sh',
		args: ['-c', 'exit 3'],
		stdin: big,
		onLine: () => undefined
	})
	assert.equal(lines.code, 3)
	const run = await defaultRunner({ ...base, command: 'sh', args: ['-c', 'exit 4'], stdin: big })
	assert.equal(run.code, 4)
})

void test('an already-aborted signal never starts the CLI', async () => {
	const signal = AbortSignal.abort()
	const started = performance.now()
	const lines = await runStreamingLines({
		...base,
		command: 'sleep',
		args: ['5'],
		signal,
		onLine: () => undefined
	})
	const run = await defaultRunner({ ...base, command: 'sleep', args: ['5'], signal })
	assert.equal(lines.aborted, true)
	assert.equal(run.aborted, true)
	assert.ok(performance.now() - started < 1_000)
})

void test('abort escalates to SIGKILL when the CLI ignores SIGTERM', async () => {
	const controller = new AbortController()
	setTimeout(() => controller.abort(), 200)
	const started = performance.now()
	const result = await runStreamingLines({
		...base,
		command: 'sh',
		args: ['-c', 'trap "" TERM; while :; do sleep 0.1; done'],
		signal: controller.signal,
		onLine: () => undefined
	})
	assert.equal(result.aborted, true)
	assert.ok(performance.now() - started < 4_000)
})

void test('a multi-byte character split across stdout chunks survives', async () => {
	// "ệ" is e1 bb 87; the pause forces two separate chunks.
	const script = "printf '\\341\\273'; sleep 0.2; printf '\\207\\n'"
	const seen: string[] = []
	await runStreamingLines({
		...base,
		command: 'sh',
		args: ['-c', script],
		onLine: (l) => seen.push(l)
	})
	assert.deepEqual(seen, ['ệ'])
	const run = await defaultRunner({ ...base, command: 'sh', args: ['-c', script] })
	assert.equal(run.stdout.trim(), 'ệ')
})
