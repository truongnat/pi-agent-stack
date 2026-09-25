import assert from 'node:assert/strict'
import test from 'node:test'
import { createGoal } from '../src/state.ts'
import { createGoalTools } from '../src/tools.ts'
import type { GoalState } from '../src/types.ts'

test('get_goal returns message when no goal active', async () => {
	const { getGoalTool } = createGoalTools({
		getGoal: () => null,
		updateGoal: () => {}
	})

	const result = await getGoalTool.execute(
		'1',
		{},
		new AbortController().signal,
		() => {},
		{} as any
	)
	const firstText = result.content[0]?.type === 'text' ? result.content[0].text : ''
	assert.match(firstText, /No active goal is set/)
})

test('get_goal returns JSON representation of active goal', async () => {
	const goal = createGoal('Implement feature X', 150000)
	goal.turns = 3
	goal.tokensUsed = 35000

	const { getGoalTool } = createGoalTools({
		getGoal: () => goal,
		updateGoal: () => {}
	})

	const result = await getGoalTool.execute(
		'1',
		{},
		new AbortController().signal,
		() => {},
		{} as any
	)
	const firstText = result.content[0]?.type === 'text' ? result.content[0].text : ''
	const parsed = JSON.parse(firstText)
	assert.equal(parsed.objective, 'Implement feature X')
	assert.equal(parsed.status, 'active')
	assert.equal(parsed.turns, 3)
	assert.equal(parsed.tokensUsed, 35000)
	assert.equal(parsed.tokenBudget, 150000)
})

test('update_goal updates status and reason', async () => {
	let state: GoalState | null = createGoal('Solve issue Y')
	let calledStatus = ''
	let calledReason = ''

	const { updateGoalTool } = createGoalTools({
		getGoal: () => state,
		updateGoal: (status, reason) => {
			calledStatus = status
			calledReason = reason
		}
	})

	const result = await updateGoalTool.execute(
		'1',
		{ status: 'complete', reason: 'All unit tests passing.' },
		new AbortController().signal,
		() => {},
		{} as any
	)

	const firstText = result.content[0]?.type === 'text' ? result.content[0].text : ''
	assert.equal(calledStatus, 'complete')
	assert.equal(calledReason, 'All unit tests passing.')
	assert.match(firstText, /successfully updated to "complete"/)
})
