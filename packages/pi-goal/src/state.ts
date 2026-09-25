import type { GoalState, GoalStatus } from './types.ts'

export const MAX_OBJECTIVE_LENGTH = 4000

export function isValidGoalStatus(status: unknown): status is GoalStatus {
	return (
		status === 'active' ||
		status === 'paused' ||
		status === 'blocked' ||
		status === 'budget_limited' ||
		status === 'complete'
	)
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`
	if (tokens < 1_000_000) {
		const val = tokens / 1000
		return val < 10 ? `${val.toFixed(1)}K` : `${Math.round(val)}K`
	}
	const val = tokens / 1_000_000
	return `${val.toFixed(1)}M`
}

export function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000))
	if (totalSec < 60) return `${totalSec}s`
	const mins = Math.floor(totalSec / 60)
	const secs = totalSec % 60
	if (mins < 60) return `${mins}m ${secs}s`
	const hours = Math.floor(mins / 60)
	const remMins = mins % 60
	return `${hours}h ${remMins}m`
}

export function createGoal(
	objective: string,
	tokenBudget?: number,
	id = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
): GoalState {
	const trimmed = objective.trim()
	const capped =
		trimmed.length > MAX_OBJECTIVE_LENGTH ? `${trimmed.slice(0, MAX_OBJECTIVE_LENGTH)}…` : trimmed
	const now = Date.now()

	return {
		id,
		objective: capped,
		status: 'active',
		tokenBudget: tokenBudget && tokenBudget > 0 ? tokenBudget : undefined,
		tokensUsed: 0,
		timeUsedMs: 0,
		turns: 0,
		emptyTurns: 0,
		sameBlockerTurns: 0,
		createdAt: now,
		updatedAt: now
	}
}

export function updateGoalState(state: GoalState, patch: Partial<GoalState>): GoalState {
	let objective = patch.objective !== undefined ? patch.objective.trim() : state.objective
	if (objective.length > MAX_OBJECTIVE_LENGTH) {
		objective = `${objective.slice(0, MAX_OBJECTIVE_LENGTH)}…`
	}

	return {
		...state,
		...patch,
		objective,
		updatedAt: Date.now()
	}
}

export function renderGoalFooter(state: GoalState): string {
	const formattedUsed = formatTokens(state.tokensUsed)
	const budgetPart = state.tokenBudget
		? `${formattedUsed}/${formatTokens(state.tokenBudget)}`
		: formattedUsed
	const statusPrefix = state.status === 'active' ? 'goal' : `goal (${state.status})`

	return `${statusPrefix} ▸ ${budgetPart} · turn ${state.turns}`
}
