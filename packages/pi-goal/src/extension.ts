import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { evaluateGoalWithJev } from './evaluator.ts'
import { applyTurnMetrics, evaluateStopRules } from './loop.ts'
import {
	buildBudgetLimitPrompt,
	buildContinuationPrompt,
	buildObjectiveUpdatedPrompt,
	buildUserMessageReminder
} from './prompts.ts'
import {
	createGoal,
	formatDuration,
	formatTokens,
	renderGoalFooter,
	updateGoalState
} from './state.ts'
import { createGoalTools } from './tools.ts'
import type { EvaluatorResult, GoalState, TurnMetrics } from './types.ts'

export function createGoalExtension(pi: ExtensionAPI) {
	let currentGoal: GoalState | null = null
	let turnStartTime = 0
	let isContinuationTurn = false
	let pendingWrapUp = false
	let turnHasText = false
	let turnHasThinking = false
	let turnHasToolCalls = false
	let lastToolSummary: string[] = []
	let lastAssistantText = ''
	let selfReportedStatus: 'complete' | 'blocked' | 'paused' | undefined
	let selfReportedReason: string | undefined
	let lastEvaluatorNote: string | undefined
	let lastMetrics: TurnMetrics | null = null

	function saveState(state: GoalState) {
		try {
			pi.appendEntry('goal-state', state)
		} catch {
			// Ignore if appendEntry unavailable
		}
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return
		if (currentGoal && currentGoal.status !== 'complete') {
			ctx.ui.setStatus('goal', renderGoalFooter(currentGoal))
		} else {
			ctx.ui.setStatus('goal', undefined)
		}
	}

	// 1. Register Tools
	const { getGoalTool, updateGoalTool } = createGoalTools({
		getGoal: () => currentGoal,
		updateGoal: (status, reason) => {
			selfReportedStatus = status
			selfReportedReason = reason
			if (currentGoal) {
				currentGoal = updateGoalState(currentGoal, {
					lastReason: reason
				})
			}
		}
	})

	pi.registerTool(getGoalTool)
	pi.registerTool(updateGoalTool)

	// 2. Lifecycle Hooks
	pi.on('session_start', (event: any, ctx) => {
		const entries = event?.entries || []
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i]
			if (e?.type === 'custom' && e?.customType === 'goal-state' && e?.data) {
				currentGoal = e.data
				break
			}
		}
		updateStatus(ctx)
	})

	pi.on('before_agent_start', (_event, _ctx) => {
		turnStartTime = performance.now()
		turnHasText = false
		turnHasThinking = false
		turnHasToolCalls = false
		lastToolSummary = []
		lastAssistantText = ''
		selfReportedStatus = undefined
		selfReportedReason = undefined

		if (currentGoal && currentGoal.status === 'active') {
			if (isContinuationTurn) {
				isContinuationTurn = false
				if (pendingWrapUp) {
					pendingWrapUp = false
					return {
						message: {
							customType: 'goal-steering',
							content: buildBudgetLimitPrompt(currentGoal),
							display: false
						}
					}
				}
				const note = lastEvaluatorNote
				lastEvaluatorNote = undefined
				return {
					message: {
						customType: 'goal-steering',
						content: buildContinuationPrompt(currentGoal, note),
						display: false
					}
				}
			}

			// User typed a manual message while a goal is active
			return {
				message: {
					customType: 'goal-reminder',
					content: buildUserMessageReminder(currentGoal),
					display: false
				}
			}
		}

		return undefined
	})

	pi.on('tool_call', (event, _ctx) => {
		turnHasToolCalls = true
		const inputStr = JSON.stringify(event.input)
		const shortInput = inputStr.length > 80 ? `${inputStr.slice(0, 80)}…` : inputStr
		lastToolSummary.push(`${event.toolName}(${shortInput})`)
	})

	pi.on('agent_end', (event: any, ctx) => {
		const metrics: TurnMetrics = {
			inputTokens: event?.usage?.input ?? 0,
			outputTokens: event?.usage?.output ?? 0,
			elapsedMs: Math.round(performance.now() - turnStartTime),
			hasText: turnHasText,
			hasThinking: turnHasThinking,
			hasToolCalls: turnHasToolCalls,
			selfReportedStatus,
			selfReportedReason,
			stopReason: event?.stopReason,
			error: event?.error ? String(event.error) : undefined
		}
		lastMetrics = metrics

		if (
			currentGoal &&
			(currentGoal.status === 'active' || currentGoal.status === 'budget_limited')
		) {
			currentGoal = applyTurnMetrics(currentGoal, metrics)
			saveState(currentGoal)
			updateStatus(ctx)
		}
	})

	pi.on('agent_settled', async (_event, ctx) => {
		if (!currentGoal || currentGoal.status !== 'active') return
		const metrics = lastMetrics || {
			inputTokens: 0,
			outputTokens: 0,
			elapsedMs: 0,
			hasText: false,
			hasThinking: false,
			hasToolCalls: false
		}

		let evaluatorResult: EvaluatorResult | undefined
		if (metrics.selfReportedStatus === 'complete') {
			evaluatorResult = await evaluateGoalWithJev({
				objective: currentGoal.objective,
				lastAssistantMessage: lastAssistantText,
				toolSummary: lastToolSummary.join('; ')
			})
			if (!evaluatorResult.met && evaluatorResult.confidence >= 0.6) {
				lastEvaluatorNote = `JEV evaluator determined the goal is not met yet: ${evaluatorResult.reason}`
			}
		}

		const decision = evaluateStopRules(currentGoal, metrics, evaluatorResult)

		if (decision.shouldStop) {
			const finalStatus = decision.newStatus ?? 'paused'
			currentGoal = updateGoalState(currentGoal, {
				status: finalStatus,
				lastReason: decision.reason
			})
			saveState(currentGoal)
			updateStatus(ctx)

			if (ctx.hasUI) {
				const label =
					finalStatus === 'complete'
						? '🎉 Goal complete!'
						: `Goal stopped (${finalStatus}): ${decision.reason}`
				ctx.ui.notify(
					`${label}\n- Turns: ${currentGoal.turns}\n- Tokens: ${formatTokens(currentGoal.tokensUsed)}\n- Duration: ${formatDuration(currentGoal.timeUsedMs)}`,
					finalStatus === 'complete' ? 'info' : 'warning'
				)
			}
			return
		}

		if (decision.isWrapUpTurn) {
			currentGoal = updateGoalState(currentGoal, {
				status: 'budget_limited',
				lastReason: decision.reason
			})
			saveState(currentGoal)
			updateStatus(ctx)
			pendingWrapUp = true
			isContinuationTurn = true
			pi.sendUserMessage('Complete the wrap-up summary for the token budget limit.')
			return
		}

		// Continue goal loop
		isContinuationTurn = true
		pi.sendUserMessage(`Continue the goal (turn ${currentGoal.turns + 1}).`)
	})

	// 3. Register Command /goal
	pi.registerCommand('goal', {
		description: 'Autonomous goal loop: /goal <objective> | pause | resume | clear | edit | budget',
		handler: async (args, ctx) => {
			const input = (args ?? '').trim()

			if (input.startsWith('pause')) {
				if (!currentGoal) {
					ctx.ui.notify('No active goal to pause.', 'warning')
					return
				}
				currentGoal = updateGoalState(currentGoal, {
					status: 'paused',
					lastReason: 'Paused by user via /goal pause'
				})
				saveState(currentGoal)
				updateStatus(ctx)
				ctx.ui.notify('Goal paused. Use /goal resume to continue.', 'info')
				return
			}

			if (input.startsWith('resume')) {
				if (!currentGoal) {
					ctx.ui.notify('No goal to resume. Use /goal <objective> to create one.', 'warning')
					return
				}
				currentGoal = updateGoalState(currentGoal, {
					status: 'active',
					lastReason: undefined
				})
				saveState(currentGoal)
				updateStatus(ctx)
				ctx.ui.notify(`Resuming goal: "${currentGoal.objective}"`, 'info')
				isContinuationTurn = true
				pi.sendUserMessage(`Resume goal (turn ${currentGoal.turns + 1}).`)
				return
			}

			if (input.startsWith('clear')) {
				currentGoal = null
				updateStatus(ctx)
				ctx.ui.notify('Goal cleared.', 'info')
				return
			}

			if (input.startsWith('edit ')) {
				const newObjective = input.replace('edit ', '').trim()
				if (!newObjective) {
					ctx.ui.notify('Usage: /goal edit <new objective>', 'warning')
					return
				}
				if (!currentGoal) {
					currentGoal = createGoal(newObjective)
				} else {
					const old = currentGoal.objective
					currentGoal = updateGoalState(currentGoal, { objective: newObjective })
					if (isContinuationTurn) {
						pi.sendUserMessage(buildObjectiveUpdatedPrompt(old, newObjective))
					}
				}
				saveState(currentGoal)
				updateStatus(ctx)
				ctx.ui.notify('Goal objective updated.', 'info')
				return
			}

			if (input.startsWith('budget ')) {
				const budgetStr = input.replace('budget ', '').trim()
				const budget = Number.parseInt(budgetStr, 10)
				if (Number.isNaN(budget) || budget <= 0) {
					ctx.ui.notify('Usage: /goal budget <tokens> (e.g. /goal budget 200000)', 'warning')
					return
				}
				if (!currentGoal) {
					ctx.ui.notify('No active goal. Set a goal first with /goal <objective>.', 'warning')
					return
				}
				currentGoal = updateGoalState(currentGoal, { tokenBudget: budget })
				saveState(currentGoal)
				updateStatus(ctx)
				ctx.ui.notify(`Token budget updated to ${formatTokens(budget)} tokens.`, 'info')
				return
			}

			// If objective is provided as argument
			if (input.length > 0) {
				currentGoal = createGoal(input)
				saveState(currentGoal)
				updateStatus(ctx)
				ctx.ui.notify(`Goal set: "${currentGoal.objective}"`, 'info')
				isContinuationTurn = true
				pi.sendUserMessage(`Start working on goal: "${currentGoal.objective}".`)
				return
			}

			// Interactive menu when /goal is called with no args
			if (!ctx.hasUI) {
				ctx.ui.notify('Usage: /goal <objective> | pause | resume | clear | edit | budget', 'info')
				return
			}

			if (!currentGoal) {
				const entered = await ctx.ui.input('Enter goal objective:')
				if (entered && entered.trim()) {
					currentGoal = createGoal(entered.trim())
					saveState(currentGoal)
					updateStatus(ctx)
					ctx.ui.notify(`Goal set: "${currentGoal.objective}"`, 'info')
					isContinuationTurn = true
					pi.sendUserMessage(`Start working on goal: "${currentGoal.objective}".`)
				}
				return
			}

			// Goal exists: present summary and menu
			const statusUpper = currentGoal.status.toUpperCase()
			const budgetText = currentGoal.tokenBudget
				? `${formatTokens(currentGoal.tokensUsed)} / ${formatTokens(currentGoal.tokenBudget)}`
				: `${formatTokens(currentGoal.tokensUsed)} (no limit)`
			const durationText = formatDuration(currentGoal.timeUsedMs)

			const menuItems = [
				currentGoal.status === 'active' ? '⏸️  Pause goal' : '▶️  Resume goal',
				'✏️  Edit objective',
				'💰 Set token budget',
				'🗑️  Clear goal',
				'❌ Close menu'
			]

			const picked = await ctx.ui.select(
				`Goal [${statusUpper}] · ${budgetText} · ${durationText} · Turn ${currentGoal.turns}\nObjective: ${currentGoal.objective}${currentGoal.lastReason ? `\nReason: ${currentGoal.lastReason}` : ''}`,
				menuItems
			)

			if (picked === '⏸️  Pause goal') {
				currentGoal = updateGoalState(currentGoal, {
					status: 'paused',
					lastReason: 'Paused via menu'
				})
				saveState(currentGoal)
				updateStatus(ctx)
				ctx.ui.notify('Goal paused.', 'info')
			} else if (picked === '▶️  Resume goal') {
				currentGoal = updateGoalState(currentGoal, {
					status: 'active',
					lastReason: undefined
				})
				saveState(currentGoal)
				updateStatus(ctx)
				isContinuationTurn = true
				pi.sendUserMessage(`Resume goal (turn ${currentGoal.turns + 1}).`)
			} else if (picked === '✏️  Edit objective') {
				const edit = await ctx.ui.input('Edit objective:', currentGoal.objective)
				if (edit && edit.trim()) {
					currentGoal = updateGoalState(currentGoal, { objective: edit.trim() })
					saveState(currentGoal)
					updateStatus(ctx)
					ctx.ui.notify('Objective updated.', 'info')
				}
			} else if (picked === '💰 Set token budget') {
				const budgetInput = await ctx.ui.input(
					'Enter token budget (e.g. 200000):',
					currentGoal.tokenBudget ? String(currentGoal.tokenBudget) : ''
				)
				if (budgetInput) {
					const b = Number.parseInt(budgetInput.trim(), 10)
					if (!Number.isNaN(b) && b > 0) {
						currentGoal = updateGoalState(currentGoal, { tokenBudget: b })
						saveState(currentGoal)
						updateStatus(ctx)
						ctx.ui.notify(`Token budget set to ${formatTokens(b)}.`, 'info')
					}
				}
			} else if (picked === '🗑️  Clear goal') {
				const ok = await ctx.ui.confirm(
					'Clear goal?',
					'Are you sure you want to clear the active goal?'
				)
				if (ok) {
					currentGoal = null
					updateStatus(ctx)
					ctx.ui.notify('Goal cleared.', 'info')
				}
			}
		}
	})

	return {
		getGoal: () => currentGoal,
		setGoal: (goal: GoalState | null) => {
			currentGoal = goal
		}
	}
}
