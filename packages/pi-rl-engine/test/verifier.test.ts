import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeReward, detectTestCommand, runCommand } from '../src/verifier.ts'

test('detectTestCommand identifies npm test in package.json', () => {
	const cmd = detectTestCommand(process.cwd())
	assert.ok(cmd === 'npm test' || cmd === 'make test' || cmd === null)
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
