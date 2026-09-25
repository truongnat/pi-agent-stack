import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createGoal,
	formatDuration,
	formatTokens,
	renderGoalFooter,
	updateGoalState
} from '../src/state.ts'

test('createGoal initializes state with defaults and caps objective length', () => {
	const goal = createGoal('Build unit test suite', 100000)
	assert.ok(goal.id.startsWith('goal_'))
	assert.equal(goal.objective, 'Build unit test suite')
	assert.equal(goal.status, 'active')
	assert.equal(goal.tokenBudget, 100000)
	assert.equal(goal.tokensUsed, 0)
	assert.equal(goal.turns, 0)
	assert.equal(goal.emptyTurns, 0)

	const longObj = 'A'.repeat(5000)
	const capped = createGoal(longObj)
	assert.equal(capped.objective.length, 4001) // 4000 + '…'
})

test('updateGoalState patches fields and updates updatedAt timestamp', () => {
	const goal = createGoal('Original objective')
	const updated = updateGoalState(goal, {
		status: 'paused',
		turns: 5,
		tokensUsed: 12000
	})

	assert.equal(updated.status, 'paused')
	assert.equal(updated.turns, 5)
	assert.equal(updated.tokensUsed, 12000)
	assert.ok(updated.updatedAt >= goal.updatedAt)
})

test('formatTokens formats small, medium, and large token counts', () => {
	assert.equal(formatTokens(450), '450')
	assert.equal(formatTokens(4500), '4.5K')
	assert.equal(formatTokens(54000), '54K')
	assert.equal(formatTokens(1250000), '1.3M')
})

test('formatDuration formats seconds, minutes, and hours', () => {
	assert.equal(formatDuration(45000), '45s')
	assert.equal(formatDuration(125000), '2m 5s')
	assert.equal(formatDuration(3665000), '1h 1m')
})

test('renderGoalFooter displays active and paused status with budgets and turns', () => {
	const activeNoBudget = createGoal('Do task')
	activeNoBudget.tokensUsed = 15000
	activeNoBudget.turns = 2
	assert.equal(renderGoalFooter(activeNoBudget), 'goal ▸ 15K · turn 2')

	const activeWithBudget = createGoal('Do task', 200000)
	activeWithBudget.tokensUsed = 40000
	activeWithBudget.turns = 3
	assert.equal(renderGoalFooter(activeWithBudget), 'goal ▸ 40K/200K · turn 3')

	const pausedGoal = updateGoalState(activeWithBudget, { status: 'paused' })
	assert.equal(renderGoalFooter(pausedGoal), 'goal (paused) ▸ 40K/200K · turn 3')
})
