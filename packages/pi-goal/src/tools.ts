import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import * as t from 'typebox'
import type { GoalState } from './types.ts'

export interface GoalToolContext {
	getGoal: () => GoalState | null
	updateGoal: (status: 'complete' | 'blocked' | 'paused', reason: string) => void
}

const GetGoalSchema = t.Object({})

const UpdateGoalSchema = t.Object({
	status: t.Union([
		t.Literal('complete', {
			description: 'All requirements of the goal have been accomplished and verified.'
		}),
		t.Literal('blocked', {
			description: 'The goal is blocked by an external requirement or unsolvable error.'
		}),
		t.Literal('paused', {
			description: 'Goal execution is paused (only when explicitly requested by the user).'
		})
	]),
	reason: t.String({
		description: 'Detailed explanation of why the status is being updated and what was verified.'
	})
})

export function createGoalTools(ctx: GoalToolContext): {
	getGoalTool: ToolDefinition<typeof GetGoalSchema>
	updateGoalTool: ToolDefinition<typeof UpdateGoalSchema>
} {
	const getGoalTool: ToolDefinition<typeof GetGoalSchema> = defineTool({
		name: 'get_goal',
		label: 'Get Active Goal',
		description:
			'Retrieve the current autonomous goal objective, status, token budget, tokens used, and progress metrics when an autonomous /goal loop is running. Do NOT call this for regular conversation unless the user specifically launched a goal with /goal.',
		promptSnippet:
			'get_goal() — ONLY call if the user explicitly started an autonomous /goal loop session',
		parameters: GetGoalSchema,
		executionMode: 'sequential',
		async execute() {
			const goal = ctx.getGoal()
			if (!goal) {
				return {
					content: [
						{
							type: 'text',
							text: 'No active autonomous goal is set for this session. (Goals are created by user via /goal command).'
						}
					],
					details: undefined
				}
			}

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								id: goal.id,
								objective: goal.objective,
								status: goal.status,
								turns: goal.turns,
								tokensUsed: goal.tokensUsed,
								tokenBudget: goal.tokenBudget ?? 'unlimited',
								timeUsedMs: goal.timeUsedMs,
								lastReason: goal.lastReason ?? null
							},
							null,
							2
						)
					}
				],
				details: goal
			}
		}
	})

	const updateGoalTool: ToolDefinition<typeof UpdateGoalSchema> = defineTool({
		name: 'update_goal',
		label: 'Update Goal Status',
		description:
			'Update the goal status to complete, blocked, or paused with a detailed verification reason.',
		promptSnippet: 'update_goal({ status, reason }) — update goal status',
		parameters: UpdateGoalSchema,
		executionMode: 'sequential',
		async execute(_toolCallId, params) {
			const goal = ctx.getGoal()
			if (!goal) {
				return {
					content: [{ type: 'text', text: 'Cannot update goal: no active goal found in session.' }],
					isError: true,
					details: undefined
				}
			}

			ctx.updateGoal(params.status, params.reason)

			return {
				content: [
					{
						type: 'text',
						text: `Goal status successfully updated to "${params.status}". Reason: ${params.reason}`
					}
				],
				details: {
					status: params.status,
					reason: params.reason
				}
			}
		}
	})

	return { getGoalTool, updateGoalTool }
}
