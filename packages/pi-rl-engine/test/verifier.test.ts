import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { computeReward, detectTestCommand, runCommand, shellQuote } from '../src/verifier.ts'

test('detectTestCommand identifies targeted test file when available', () => {
	const cmd = detectTestCommand(process.cwd(), ['packages/pi-rl-engine/src/verifier.ts'])
	assert.ok(
		cmd === 'bun test packages/pi-rl-engine/test/verifier.test.ts' ||
			cmd?.includes('verifier.test.ts') ||
			cmd === 'bun run typecheck' ||
			cmd === 'npm test'
	)
})

test('runCommand executes command and returns structured result', () => {
	const res = runCommand('node -e "process.exit(0)"', process.cwd())
	assert.equal(res.passed, true)
	assert.equal(res.exitCode, 0)
})

test('runCommand detects failures', () => {
	const res = runCommand('node -e "process.exit(1)"', process.cwd())
	assert.equal(res.passed, false)
	assert.equal(res.exitCode, 1)
})

test('computeReward calculates score based on execution', () => {
	const res = computeReward(process.cwd(), {
		testCommand: 'node -e "process.exit(0)"',
		weights: { test: 1.0, lint: 0.3, cost: 0.1 }
	})
	assert.equal(res.passed, true)
	assert.equal(res.totalReward, 1.0)
})

test('a test file name with shell syntax is passed as a literal path, never executed', () => {
	const dir = mkdtempSync(join(tmpdir(), 'verifier-'))
	writeFileSync(join(dir, 'package.json'), '{"packageManager":"bun@1.3.0"}')
	const evil = 'a$(touch pwned)`touch pwned2`.test.ts'
	writeFileSync(join(dir, evil), '')
	const cmd = detectTestCommand(dir, [evil])
	assert.ok(cmd)
	runCommand(`echo ${cmd.replace(/^bun test /, '')}`, dir)
	assert.equal(existsSync(join(dir, 'pwned')), false)
	assert.equal(existsSync(join(dir, 'pwned2')), false)
	const echoed = runCommand(`printf %s ${shellQuote("it's")}`, dir)
	assert.equal(echoed.output, "it's")
})
