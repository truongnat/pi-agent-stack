import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ContextualBandit } from '../src/bandit.ts'

test('ContextualBandit initializes, updates Q-values and persists state', () => {
	const testDb = join(process.cwd(), 'test-qtable.tmp.json')
	try {
		const bandit = new ContextualBandit(testDb)
		const entry = bandit.getEntry('fix', 'gpt-5.6-luna', 'high')
		assert.equal(entry.qValue, 0.5)

		// Reward positive update
		bandit.update('fix', 'gpt-5.6-luna', 'high', 1.0, 0.5)
		const updated = bandit.getEntry('fix', 'gpt-5.6-luna', 'high')
		assert.ok(updated.qValue > 0.5)
		assert.equal(updated.trials, 1)
		assert.equal(updated.successes, 1)

		// Best arm selection with epsilon = 0 (exploitation)
		const chosen = bandit.selectBestArm(
			'fix',
			[
				{ model: 'gpt-5.5', thinkingLevel: 'low' },
				{ model: 'gpt-5.6-luna', thinkingLevel: 'high' }
			],
			0.0
		)
		assert.equal(chosen.model, 'gpt-5.6-luna')
		assert.equal(chosen.thinkingLevel, 'high')
	} finally {
		rmSync(testDb, { force: true })
	}
})

test('update() applies each reward to the latest on-disk state (several `pi` processes)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bandit-merge-'))
	const file = join(dir, 'q.json')
	try {
		// Two instances sharing one file, the way a main session and an orchestrator subagent
		// (separate `pi` processes) would.
		const banditA = new ContextualBandit(file)
		const banditB = new ContextualBandit(file)

		banditA.update('fix', 'model-a', 'high', 1.0)
		// banditB's in-memory qTable was loaded before banditA saved, so without a reload before
		// its own save, this would clobber model-a's entry with only model-b's.
		banditB.update('refactor', 'model-b', 'low', 1.0)

		const onDisk = new ContextualBandit(file).getAllEntries()
		const keys = onDisk.map((e) => `${e.taskType}::${e.model}::${e.thinkingLevel}`).sort()
		assert.deepEqual(keys, ['fix::model-a::high', 'refactor::model-b::low'])
		assert.throws(() => statSync(`${file}.lock`), 'lock released')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a corrupt Q-table is moved aside, not erased by the next save', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bandit-'))
	const file = join(dir, 'q.json')
	writeFileSync(file, '[{"taskType": "fix"')
	const bandit = new ContextualBandit(file)
	bandit.save()
	assert.ok(readdirSync(dir).some((f) => f.startsWith('q.json.corrupt-')))
})
