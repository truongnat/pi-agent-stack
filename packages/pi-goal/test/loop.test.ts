import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTurnMetrics, evaluateStopRules } from '../src/loop.ts'
import { createGoal } from '../src/state.ts'
import type { TurnMetrics } from '../src/types.ts'

test('applyTurnMetrics accumulates tokens, time, and tracks empty turns', () => {
	const goal = createGoal('Optimize search query')
	const m1: TurnMetrics = {
		inputTokens: 1000,
		outputTokens: 500,
		elapsedMs: 2000,
		hasText: true,
		hasThinking: false,
		hasToolCalls: true
	}

	const next1 = applyTurnMetrics(goal, m1)
	assert.equal(next1.tokensUsed, 1500)
	assert.equal(next1.timeUsedMs, 2000)
	assert.equal(next1.turns, 1)
	assert.equal(next1.emptyTurns, 0)

	const mEmpty: TurnMetrics = {
		inputTokens: 200,
		outputTokens: 50,
		elapsedMs: 500,
		hasText: false,
		hasThinking: false,
		hasToolCalls: false
	}

	const next2 = applyTurnMetrics(next1, mEmpty)
	assert.equal(next2.turns, 2)
	assert.equal(next2.emptyTurns, 1)
})

test('evaluateStopRules handles user abort (Esc)', () => {
	const goal = createGoal('Run migration')
	const decision = evaluateStopRules(goal, {
		inputTokens: 100,
		outputTokens: 50,
		elapsedMs: 300,
		hasText: false,
		hasThinking: false,
		hasToolCalls: false,
		stopReason: 'aborted'
	})

	assert.equal(decision.shouldStop, true)
	assert.equal(decision.newStatus, 'paused')
	assert.match(decision.reason!, /paused by user/)
})

test('evaluateStopRules stops on model complete self-report', () => {
	const goal = createGoal('Write unit test')
	const decision = evaluateStopRules(goal, {
		inputTokens: 1000,
		outputTokens: 500,
		elapsedMs: 1200,
		hasText: true,
		hasThinking: false,
		hasToolCalls: true,
		selfReportedStatus: 'complete',
		selfReportedReason: 'Tests verified.'
	})

	assert.equal(decision.shouldStop, true)
	assert.equal(decision.newStatus, 'complete')
	assert.equal(decision.reason, 'Tests verified.')
})

test('evaluateStopRules overrules self-reported complete if JEV evaluator disagrees', () => {
	const goal = createGoal('Write unit test')
	const decision = evaluateStopRules(
		goal,
		{
			inputTokens: 1000,
			outputTokens: 500,
			elapsedMs: 1200,
			hasText: true,
			hasThinking: false,
			hasToolCalls: true,
			selfReportedStatus: 'complete',
			selfReportedReason: 'All done.'
		},
		{
			met: false,
			confidence: 0.85,
			reason: 'Test suite failed on edge cases.'
		}
	)

	assert.equal(decision.shouldStop, false)
	assert.match(decision.reason!, /JEV evaluator determined goal is not met yet/)
})

test('evaluateStopRules stops on 3 consecutive empty turns', () => {
	const goal = createGoal('Dead loop task')
	goal.emptyTurns = 3

	const decision = evaluateStopRules(goal, {
		inputTokens: 100,
		outputTokens: 0,
		elapsedMs: 100,
		hasText: false,
		hasThinking: false,
		hasToolCalls: false
	})

	assert.equal(decision.shouldStop, true)
	assert.equal(decision.newStatus, 'blocked')
	assert.match(decision.reason!, /No progress made for 3 consecutive turns/)
})

test('evaluateStopRules triggers wrap-up turn when token budget is reached', () => {
	const goal = createGoal('Budgeted task', 20000)
	goal.tokensUsed = 21000

	const decision = evaluateStopRules(goal, {
		inputTokens: 1000,
		outputTokens: 500,
		elapsedMs: 1000,
		hasText: true,
		hasThinking: false,
		hasToolCalls: true
	})

	assert.equal(decision.shouldStop, false)
	assert.equal(decision.isWrapUpTurn, true)
	assert.equal(decision.newStatus, 'budget_limited')
})

test('evaluateStopRules pauses when turn cap is reached', () => {
	const goal = createGoal('Long running task')
	goal.turns = 30

	const decision = evaluateStopRules(
		goal,
		{
			inputTokens: 1000,
			outputTokens: 500,
			elapsedMs: 1000,
			hasText: true,
			hasThinking: false,
			hasToolCalls: true
		},
		undefined,
		{ maxTurns: 30 }
	)

	assert.equal(decision.shouldStop, true)
	assert.equal(decision.newStatus, 'paused')
	assert.match(decision.reason!, /Turn cap reached/)
})
