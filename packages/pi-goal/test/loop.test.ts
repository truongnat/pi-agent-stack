import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTurnMetrics, evaluateStopRules, normalizeBlocker } from '../src/loop.ts'
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

test('evaluateStopRules auto-recovers on transient turn errors before maxConsecutiveErrors', () => {
	const goal = createGoal('Refactor system')
	goal.consecutiveErrors = 1

	const decision = evaluateStopRules(goal, {
		inputTokens: 100,
		outputTokens: 0,
		elapsedMs: 100,
		hasText: false,
		hasThinking: false,
		hasToolCalls: false,
		error: 'API 503 Service Unavailable'
	})

	assert.equal(decision.shouldStop, false)
	assert.match(decision.reason!, /Turn error encountered \(1\/3\)/)

	// After 3 consecutive errors, it should block
	goal.consecutiveErrors = 3
	const finalDecision = evaluateStopRules(goal, {
		inputTokens: 100,
		outputTokens: 0,
		elapsedMs: 100,
		hasText: false,
		hasThinking: false,
		hasToolCalls: false,
		error: 'API 503 Service Unavailable'
	})

	assert.equal(finalDecision.shouldStop, true)
	assert.equal(finalDecision.newStatus, 'blocked')
	assert.match(finalDecision.reason!, /Turn failed after 3 consecutive errors/)
})

test('evaluateStopRules gives grace period for self-reported blockers before halting', () => {
	const goal = createGoal('Fix failing test')
	goal.sameBlockerTurns = 1

	const decision1 = evaluateStopRules(goal, {
		inputTokens: 500,
		outputTokens: 200,
		elapsedMs: 1000,
		hasText: true,
		hasThinking: false,
		hasToolCalls: true,
		selfReportedStatus: 'blocked',
		selfReportedReason: 'TypeScript compilation error in auth.ts'
	})

	assert.equal(decision1.shouldStop, false)
	assert.match(decision1.reason!, /Attempting alternative approach \(attempt 1\/3\)/)

	// After 3 consecutive blocker turns with same reason, it stops
	goal.sameBlockerTurns = 3
	const decision2 = evaluateStopRules(goal, {
		inputTokens: 500,
		outputTokens: 200,
		elapsedMs: 1000,
		hasText: true,
		hasThinking: false,
		hasToolCalls: true,
		selfReportedStatus: 'blocked',
		selfReportedReason: 'TypeScript compilation error in auth.ts'
	})

	assert.equal(decision2.shouldStop, true)
	assert.equal(decision2.newStatus, 'blocked')
})

test('turn cap still stops a model that keeps claiming completion the evaluator rejects', () => {
	const state = { ...createGoal('Ship it'), turns: 30 }
	const decision = evaluateStopRules(
		state,
		{
			inputTokens: 0,
			outputTokens: 0,
			elapsedMs: 0,
			hasText: true,
			hasThinking: false,
			hasToolCalls: true,
			selfReportedStatus: 'complete',
			selfReportedReason: 'Completed all 4 requirements'
		},
		{ met: false, confidence: 0.9, reason: 'not yet' }
	)
	assert.equal(decision.shouldStop, true)
	assert.equal(decision.newStatus, 'paused')
})

test('reworded blockers count as the same blocker', () => {
	assert.equal(normalizeBlocker('Tests fail (3 errors).'), normalizeBlocker('tests fail, 5 errors'))
})
