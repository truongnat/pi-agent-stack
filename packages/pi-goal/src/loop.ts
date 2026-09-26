import type { EvaluatorResult, GoalConfig, GoalState, StopDecision, TurnMetrics } from './types.ts'

export const DEFAULT_CONFIG: Required<GoalConfig> = {
	maxTurns: 100,
	maxObjectiveLength: 4000,
	maxEmptyTurns: 3,
	maxBlockerTurns: 3
}

export function applyTurnMetrics(state: GoalState, metrics: TurnMetrics): GoalState {
	const newTokensUsed = state.tokensUsed + (metrics.inputTokens + metrics.outputTokens)
	const newTimeUsed = state.timeUsedMs + Math.max(0, metrics.elapsedMs)
	const newTurns = state.turns + 1

	const isEmpty = !metrics.hasText && !metrics.hasThinking && !metrics.hasToolCalls
	const emptyTurns = isEmpty ? state.emptyTurns + 1 : 0

	let sameBlockerTurns = state.sameBlockerTurns
	let lastBlocker = state.lastBlocker
	if (metrics.selfReportedStatus === 'blocked') {
		const blocker = metrics.selfReportedReason?.trim() || 'unknown'
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

	// 1. Esc / user abort
	if (metrics.stopReason === 'aborted') {
		return {
			shouldStop: true,
			newStatus: 'paused',
			reason: 'Goal paused by user'
		}
	}

	// 2. Wrap-up turn finished
	if (state.status === 'budget_limited') {
		return {
			shouldStop: true,
			newStatus: 'budget_limited',
			reason: 'Token budget reached (wrap-up completed)'
		}
	}

	// 3. Model reported blocked
	if (metrics.selfReportedStatus === 'blocked') {
		return {
			shouldStop: true,
			newStatus: 'blocked',
			reason: metrics.selfReportedReason || 'Model reported blocked'
		}
	}

	// 4. Model reported paused
	if (metrics.selfReportedStatus === 'paused') {
		return {
			shouldStop: true,
			newStatus: 'paused',
			reason: metrics.selfReportedReason || 'Model requested pause'
		}
	}

	// 5. Model self-reported complete
	if (metrics.selfReportedStatus === 'complete') {
		// If Jev evaluator disagrees with high confidence, do not stop!
		if (evaluatorResult && !evaluatorResult.met && evaluatorResult.confidence >= 0.6) {
			return {
				shouldStop: false,
				reason: `JEV evaluator determined goal is not met yet: ${evaluatorResult.reason}`
			}
		}

		return {
			shouldStop: true,
			newStatus: 'complete',
			reason: metrics.selfReportedReason || 'Goal completed'
		}
	}

	// 6. Fatal turn error
	if (metrics.error) {
		return {
			shouldStop: true,
			newStatus: 'blocked',
			reason: `Turn failed with error: ${metrics.error}`
		}
	}

	// 7. No progress for 3 consecutive turns
	if (state.emptyTurns >= effectiveConfig.maxEmptyTurns) {
		return {
			shouldStop: true,
			newStatus: 'blocked',
			reason: `No progress made for ${state.emptyTurns} consecutive turns`
		}
	}

	// 8. Token budget reached (trigger 1 wrap-up turn)
	if (state.tokenBudget && state.tokensUsed >= state.tokenBudget) {
		return {
			shouldStop: false,
			isWrapUpTurn: true,
			newStatus: 'budget_limited',
			reason: `Token budget limit reached (${state.tokensUsed}/${state.tokenBudget})`
		}
	}

	// 9. Turn cap reached
	if (state.turns >= effectiveConfig.maxTurns) {
		return {
			shouldStop: true,
			newStatus: 'paused',
			reason: `Turn cap reached (${effectiveConfig.maxTurns} turns); use /goal resume to continue`
		}
	}

	return {
		shouldStop: false
	}
}
