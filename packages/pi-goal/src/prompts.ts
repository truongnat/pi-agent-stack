/**
 * Goal Prompt Templates
 * Adapted from Codex CLI (Apache-2.0, Copyright OpenAI).
 */
import type { GoalState } from './types.ts'

export function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

/**
 * Main continuation prompt sent at each automatic goal loop turn.
 */
export function buildContinuationPrompt(state: GoalState, note?: string): string {
	const escapedObjective = escapeXml(state.objective)
	const noteSection = note ? `\n\n[Previous Turn Feedback / Evaluator Note]: ${note}` : ''

	return `[Active Goal Loop · Turn ${state.turns + 1}]
<objective>
${escapedObjective}
</objective>${noteSection}

Instructions for this turn:
1. Autonomous Execution: Continue executing the goal objective above step-by-step. Inspect, modify files, run commands, and execute tests.
2. DO NOT Stop Prematurely: Finishing a single step or a planning turn is NOT goal completion. Continue immediately with the next pending task.
3. Verification & Completion:
   - Only when ALL checklist items and requirements are completely implemented and verified by running tests/builds, call:
     \`update_goal({ status: "complete", reason: "<detailed summary of what was completed and verified>" })\`
   - If genuinely blocked by an unsolvable external obstacle, call:
     \`update_goal({ status: "blocked", reason: "<detailed blocker description>" })\`
   - Otherwise, do NOT call update_goal; proceed directly with the next implementation or verification action.`
}

/**
 * Budget limit wrap-up prompt sent when token budget is exhausted.
 */
export function buildBudgetLimitPrompt(state: GoalState): string {
	const escapedObjective = escapeXml(state.objective)

	return `[Goal Token Budget Limit Reached]
<objective>
${escapedObjective}
</objective>

Your allocated token budget (${state.tokensUsed} tokens used) has been reached.
Please provide a concise final summary:
1. What was completed and verified.
2. Current progress and state of the workspace.
3. Specific remaining steps for the user to continue when ready.`
}

/**
 * Objective updated prompt when user changes the goal in-flight.
 */
export function buildObjectiveUpdatedPrompt(oldObjective: string, newObjective: string): string {
	return `[Goal Objective Updated]
The goal objective has been updated. Disregard previous goal instructions if they conflict.

<previous_objective>
${escapeXml(oldObjective)}
</previous_objective>

<new_objective>
${escapeXml(newObjective)}
</new_objective>

Please adapt your plan and continue working towards the new objective.`
}

/**
 * Short reminder injected when the user sends a manual message during an active goal.
 */
export function buildUserMessageReminder(state: GoalState): string {
	const summary =
		state.objective.length > 100 ? `${state.objective.slice(0, 100)}…` : state.objective
	return `[Active Goal Reminder: "${summary}" · Turn ${state.turns}] Please address this user message first, then proceed with the active goal.`
}
