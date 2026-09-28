import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

test('a corrupt Q-table is moved aside, not erased by the next save', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bandit-'))
	const file = join(dir, 'q.json')
	writeFileSync(file, '[{"taskType": "fix"')
	const bandit = new ContextualBandit(file)
	bandit.save()
	assert.ok(readdirSync(dir).some((f) => f.startsWith('q.json.corrupt-')))
})
