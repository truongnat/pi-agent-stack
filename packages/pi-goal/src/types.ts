export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete'

export interface GoalState {
	id: string
	objective: string
	status: GoalStatus
	tokenBudget?: number
	tokensUsed: number
	timeUsedMs: number
	turns: number
	emptyTurns: number
	sameBlockerTurns: number
	consecutiveErrors?: number
	lastReason?: string
	lastBlocker?: string
	/** Turn count when the goal was last resumed; the turn cap counts from here. */
	resumedAtTurn?: number
	createdAt: number
	updatedAt: number
}

export interface GoalConfig {
	maxTurns?: number
	maxObjectiveLength?: number
	maxEmptyTurns?: number
	maxBlockerTurns?: number
	maxConsecutiveErrors?: number
}

export interface TurnMetrics {
	inputTokens: number
	outputTokens: number
	elapsedMs: number
	hasText: boolean
	hasThinking: boolean
	hasToolCalls: boolean
	selfReportedStatus?: 'complete' | 'blocked' | 'paused'
	selfReportedReason?: string
	stopReason?: string
	error?: string
}

export interface StopDecision {
	shouldStop: boolean
	newStatus?: GoalStatus
	reason?: string
	isWrapUpTurn?: boolean
}

export interface EvaluatorResult {
	met: boolean
	confidence: number
	reason: string
}
