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

Autonomous Execution Directives:
1. Continuous Progress: Advance the goal step-by-step. Read files, write code, run commands, and execute tests.
2. Self-Healing & Debugging: If a test fails, a compiler errors, or a command fails, diagnose the root cause and fix it immediately. Do NOT call \`update_goal(status: "blocked")\` for solvable bugs.
3. Multi-Step Tasks: Completing one subtask or a planning step is NOT goal completion. Proceed immediately to the next task in the plan.
4. Goal Completion:
   - Call \`update_goal({ status: "complete", reason: "<detailed proof & verification summary>" })\` ONLY after all requirements are fully implemented and verified via passing test/build commands.
   - If genuinely blocked by an impossible external dependency (missing human credentials), explain clearly and call \`update_goal({ status: "blocked", reason: "..." })\`.
   - Otherwise, do NOT call update_goal; execute the next coding/verification action directly.`
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

/**
 * Immediate injection prompt — sent via /goal inject <message> to push context
 * into the running goal loop right now, without waiting for the next turn cycle.
 */
export function buildInjectPrompt(state: GoalState, message: string): string {
	const escapedObjective = escapeXml(state.objective)
	const escapedMessage = escapeXml(message)

	return `[Goal Injection · Turn ${state.turns + 1}]
<objective>
${escapedObjective}
</objective>

<injected_message>
${escapedMessage}
</injected_message>

A message has been injected mid-loop by the user. Please:
1. Acknowledge and incorporate this message into your ongoing execution plan.
2. Adapt your next actions accordingly if needed.
3. Continue making progress toward the goal without calling update_goal unless truly complete or blocked.`
}
