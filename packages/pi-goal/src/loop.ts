import type { EvaluatorResult, GoalConfig, GoalState, StopDecision, TurnMetrics } from './types.ts'

export const DEFAULT_CONFIG: Required<GoalConfig> = {
	maxTurns: 100,
	maxObjectiveLength: 4000,
	maxEmptyTurns: 3,
	maxBlockerTurns: 3,
	maxConsecutiveErrors: 3
}

/** "Tests fail (3 errors)." and "tests fail, 5 errors" are the same blocker. */
export function normalizeBlocker(reason: string | undefined): string {
	const words = (reason ?? '')
		.toLowerCase()
		.replace(/[\d\W_]+/g, ' ')
		.trim()
	return words || 'unknown'
}

export function applyTurnMetrics(state: GoalState, metrics: TurnMetrics): GoalState {
	const newTokensUsed = state.tokensUsed + (metrics.inputTokens + metrics.outputTokens)
	const newTimeUsed = state.timeUsedMs + Math.max(0, metrics.elapsedMs)
	const newTurns = state.turns + 1

	const isEmpty = !metrics.hasText && !metrics.hasThinking && !metrics.hasToolCalls
	const emptyTurns = isEmpty ? state.emptyTurns + 1 : 0
	const consecutiveErrors = metrics.error ? (state.consecutiveErrors || 0) + 1 : 0

	let sameBlockerTurns = state.sameBlockerTurns
	let lastBlocker = state.lastBlocker
	if (metrics.selfReportedStatus === 'blocked') {
		const blocker = normalizeBlocker(metrics.selfReportedReason)
		if (blocker === state.lastBlocker) {
			sameBlockerTurns++
		} else {
			sameBlockerTurns = 1
			lastBlocker = blocker
		}
	} else {
		sameBlockerTurns = 0
		lastBlocker = undefined
	}

	return {
		...state,
		tokensUsed: newTokensUsed,
		timeUsedMs: newTimeUsed,
		turns: newTurns,
		emptyTurns,
		sameBlockerTurns,
		consecutiveErrors,
		lastBlocker,
		updatedAt: Date.now()
	}
}

export function evaluateStopRules(
	state: GoalState,
	metrics: TurnMetrics,
	evaluatorResult?: EvaluatorResult,
	config: GoalConfig = {}
): StopDecision {
	const effectiveConfig = { ...DEFAULT_CONFIG, ...config }
	const evaluatorRejected =
		metrics.selfReportedStatus === 'complete' &&
		evaluatorResult !== undefined &&
		!evaluatorResult.met &&
		evaluatorResult.confidence >= 0.6

	// 1. Esc / user abort
	if (metrics.stopReason === 'aborted') {
		return { shouldStop: true, newStatus: 'paused', reason: 'Goal paused by user' }
	}

	// 2. Wrap-up turn finished
	if (state.status === 'budget_limited') {
		return {
			shouldStop: true,
			newStatus: 'budget_limited',
			reason: 'Token budget reached (wrap-up completed)'
		}
	}

	// 3. Model asked to pause, or finished and nothing disagrees
	if (metrics.selfReportedStatus === 'paused') {
		return {
			shouldStop: true,
			newStatus: 'paused',
			reason: metrics.selfReportedReason || 'Model requested pause'
		}
	}
	if (metrics.selfReportedStatus === 'complete' && !evaluatorRejected) {
		return {
			shouldStop: true,
			newStatus: 'complete',
			reason: metrics.selfReportedReason || 'Goal completed'
		}
	}

	// 4. Hard stops. These run before any "keep going" answer, so a model that keeps
	// claiming completion or reporting new blockers still hits the caps.
	if (
		metrics.selfReportedStatus === 'blocked' &&
		state.sameBlockerTurns >= effectiveConfig.maxBlockerTurns
	) {
		return {
			shouldStop: true,
			newStatus: 'blocked',
			reason: metrics.selfReportedReason || 'Model reported persistent blocker'
		}
	}
	if (metrics.error && (state.consecutiveErrors || 0) >= effectiveConfig.maxConsecutiveErrors) {
		return {
			shouldStop: true,
			newStatus: 'blocked',
			reason: `Turn failed after ${state.consecutiveErrors} consecutive errors: ${metrics.error}`
		}
	}
	if (state.emptyTurns >= effectiveConfig.maxEmptyTurns) {
		return {
			shouldStop: true,
			newStatus: 'blocked',
			reason: `No progress made for ${state.emptyTurns} consecutive turns`
		}
	}
	if (state.tokenBudget && state.tokensUsed >= state.tokenBudget) {
		return {
			shouldStop: false,
			isWrapUpTurn: true,
			newStatus: 'budget_limited',
			reason: `Token budget limit reached (${state.tokensUsed}/${state.tokenBudget})`
		}
	}
	if (state.turns - (state.resumedAtTurn ?? 0) >= effectiveConfig.maxTurns) {
		return {
			shouldStop: true,
			newStatus: 'paused',
			reason: `Turn cap reached (${effectiveConfig.maxTurns} turns); use /goal resume to continue`
		}
	}

	// 5. Keep going, with a note for the next turn
	if (evaluatorRejected) {
		return {
			shouldStop: false,
			reason: `JEV evaluator determined goal is not met yet: ${evaluatorResult.reason}`
		}
	}
	if (metrics.selfReportedStatus === 'blocked') {
		return {
			shouldStop: false,
			reason: `Obstacle reported: "${metrics.selfReportedReason}". Attempting alternative approach (attempt ${state.sameBlockerTurns}/${effectiveConfig.maxBlockerTurns})...`
		}
	}
	if (metrics.error) {
		return {
			shouldStop: false,
			reason: `Turn error encountered (${state.consecutiveErrors}/${effectiveConfig.maxConsecutiveErrors}): ${metrics.error}. Attempting automatic recovery...`
		}
	}
	return { shouldStop: false }
}
