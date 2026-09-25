import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyStats, shadowSummary } from './index.ts'
import { recordShadow } from './model-route.ts'

void test('route-shadow rows measure agreement and cost against the plain route', () => {
	const rows: Record<string, unknown>[] = []
	const stats = emptyStats()
	const h = { stats, log: (row: Record<string, unknown>) => void rows.push(row) }
	const model = (provider: string, id: string, input: number, output: number) => ({
		provider,
		id,
		cost: { input, output }
	})
	const turn = (current: string) => ({
		kind: 'answer',
		selected: { choice: 'x', confidence: 0.9 },
		currentKey: current,
		baselineCost: 12
	})
	recordShadow(h, model('openai-codex', 'gpt-6-luna', 2, 10), turn('openai-codex/gpt-6-luna'))
	recordShadow(h, model('openai-codex', 'spark', 1, 2), turn('openai-codex/gpt-6-luna'))
	const { shadowTurns, shadowAgree, shadowBaselineCost, shadowAppliedCost } = stats
	assert.deepEqual(
		[shadowTurns, shadowAgree, shadowBaselineCost, shadowAppliedCost],
		[2, 1, 24, 15]
	)
	assert.equal(rows[1]?.applied, 'openai-codex/spark')
	assert.equal(rows[1]?.agree, false)
	assert.match(shadowSummary(stats), /1\/2 turns \(50%\); routes used cost ~63%/)
})
