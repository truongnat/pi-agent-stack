import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'

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

	// Custom message renderers
	if (typeof pi.registerMessageRenderer === 'function') {
		pi.registerMessageRenderer('goal-steering', (message, { expanded, outputPad }, theme) => {
			const badge = theme.fg('accent', theme.bold('[ 🎯 GOAL STEERING ]'))
			const turnInfo = currentGoal ? ` · Turn ${currentGoal.turns + 1}` : ''
			const header = `${badge} ${theme.bold(`Autonomous Loop${turnInfo}`)}`
			const lines = [header]

			if (currentGoal) {
				lines.push(theme.fg('accent', `  Objective: "${currentGoal.objective}"`))
				if (currentGoal.tokenBudget) {
					const ratio = currentGoal.tokensUsed / currentGoal.tokenBudget
					const clamped = Math.max(0, Math.min(1, ratio))
					const filled = Math.round(clamped * 12)
					const empty = Math.max(0, 12 - filled)
					const bar = `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
					lines.push(
						theme.fg(
							'muted',
							`  Budget: ${bar} ${formatTokens(currentGoal.tokensUsed)} / ${formatTokens(currentGoal.tokenBudget)} (${Math.round(ratio * 100)}%)`
						)
					)
				}
			}

			const contentStr =
				typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
			if (expanded) {
				lines.push(...contentStr.split('\n').map((l: string) => theme.fg('dim', `  ${l}`)))
			}

			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(lines.join('\n'), 0, 0))
			return box
		})

		pi.registerMessageRenderer('goal-reminder', (_message, { outputPad }, theme) => {
			const badge = theme.fg('warning', theme.bold('[ 🎯 GOAL REMINDER ]'))
			const header = `${badge} ${theme.bold('Active Goal Tracking')}`
			const lines = [header]
			if (currentGoal) {
				lines.push(theme.fg('muted', `  Active Objective: "${currentGoal.objective}"`))
			}
			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(lines.join('\n'), 0, 0))
			return box
		})
	}

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
				const isComplete = finalStatus === 'complete'
				const title = isComplete ? '🎉 Goal Complete!' : `Goal Stopped (${finalStatus})`
				const report = [
					title,
					`• Objective: "${currentGoal.objective}"`,
					`• Total Tokens Used: ${currentGoal.tokensUsed.toLocaleString()} tokens (~${formatTokens(currentGoal.tokensUsed)})`,
					`• Total Turns: ${currentGoal.turns}`,
					`• Total Elapsed Time: ${formatDuration(currentGoal.timeUsedMs)}`,
					`• Reason: ${decision.reason || (isComplete ? 'All criteria verified' : 'N/A')}`
				].join('\n')

				ctx.ui.notify(report, isComplete ? 'info' : 'warning')
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
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[Goal Turn ${currentGoal.turns}]: +${(metrics.inputTokens + metrics.outputTokens).toLocaleString()} tokens · Total Tokens: ${currentGoal.tokensUsed.toLocaleString()} (~${formatTokens(currentGoal.tokensUsed)})\n⚠️ Token budget reached. Starting final wrap-up turn...`,
					'warning'
				)
			}
			pi.sendUserMessage('Complete the wrap-up summary for the token budget limit.')
			return
		}

		// Continue goal loop
		if (ctx.hasUI) {
			const turnTokens = metrics.inputTokens + metrics.outputTokens
			ctx.ui.notify(
				`[Goal Turn ${currentGoal.turns}]: +${turnTokens.toLocaleString()} tokens · Total: ${currentGoal.tokensUsed.toLocaleString()} tokens (~${formatTokens(currentGoal.tokensUsed)})`,
				'info'
			)
		}
		isContinuationTurn = true
		pi.sendUserMessage(`Continue the goal (turn ${currentGoal.turns + 1}).`)
	})

	function sendGoalMessage(
		ctx: ExtensionContext,
		content: string,
		details?: Record<string, unknown>
	) {
		if (typeof pi.sendMessage === 'function') {
			pi.sendMessage({
				customType: 'goal-steering',
				content,
				display: true,
				details
			} as any)
		} else {
			ctx.ui.notify(content, 'info')
		}
	}

	// 3. Register Command /goal
	pi.registerCommand('goal', {
		description:
			'Autonomous goal loop: /goal <objective> | status | pause | resume | clear | edit | budget',
		handler: async (args, ctx) => {
			const input = (args ?? '').trim()

			if (input === 'status' || input === 'summary') {
				if (!currentGoal) {
					sendGoalMessage(ctx, 'No active goal. Start one with `/goal <objective>`.', {
						action: 'status'
					})
					return
				}
				const budgetText = currentGoal.tokenBudget
					? `${formatTokens(currentGoal.tokensUsed)} / ${formatTokens(currentGoal.tokenBudget)} (${Math.round((currentGoal.tokensUsed / currentGoal.tokenBudget) * 100)}%)`
					: `${formatTokens(currentGoal.tokensUsed)} (no budget limit)`
				const text = [
					`### 🎯 Autonomous Goal Dashboard:`,
					`• Objective: "${currentGoal.objective}"`,
					`• Status: ${currentGoal.status.toUpperCase()} (Turn ${currentGoal.turns})`,
					`• Token Budget: ${budgetText}`,
					`• Elapsed Time: ${formatDuration(currentGoal.timeUsedMs)}`,
					currentGoal.lastReason ? `• Last Reason: ${currentGoal.lastReason}` : undefined
				]
					.filter(Boolean)
					.join('\n')
				sendGoalMessage(ctx, text, { action: 'status' })
				return
			}

			if (input.startsWith('pause')) {
				if (!currentGoal) {
					sendGoalMessage(ctx, 'No active goal to pause.', { action: 'pause' })
					return
				}
				currentGoal = updateGoalState(currentGoal, {
					status: 'paused',
					lastReason: 'Paused by user via /goal pause'
				})
				saveState(currentGoal)
				updateStatus(ctx)
				sendGoalMessage(
					ctx,
					`⏸️ Goal paused: "${currentGoal.objective}". Use \`/goal resume\` to continue.`,
					{ action: 'pause' }
				)
				return
			}

			if (input.startsWith('resume')) {
				if (!currentGoal) {
					sendGoalMessage(ctx, 'No goal to resume. Use `/goal <objective>` to create one.', {
						action: 'resume'
					})
					return
				}
				currentGoal = updateGoalState(currentGoal, {
					status: 'active',
					lastReason: undefined
				})
				saveState(currentGoal)
				updateStatus(ctx)
				sendGoalMessage(
					ctx,
					`▶️ Resuming goal: "${currentGoal.objective}" (Turn ${currentGoal.turns + 1})`,
					{ action: 'resume' }
				)
				isContinuationTurn = true
				pi.sendUserMessage(`Resume goal (turn ${currentGoal.turns + 1}).`)
				return
			}

			if (input.startsWith('clear')) {
				currentGoal = null
				updateStatus(ctx)
				sendGoalMessage(ctx, '🗑️ Active goal cleared.', { action: 'clear' })
				return
			}

			if (input.startsWith('edit ')) {
				const newObjective = input.replace('edit ', '').trim()
				if (!newObjective) {
					sendGoalMessage(ctx, 'Usage: `/goal edit <new objective>`', { action: 'edit' })
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
				sendGoalMessage(ctx, `✏️ Goal objective updated: "${currentGoal.objective}"`, {
					action: 'edit'
				})
				return
			}

			if (input.startsWith('budget ')) {
				const budgetStr = input.replace('budget ', '').trim()
				const budget = Number.parseInt(budgetStr, 10)
				if (Number.isNaN(budget) || budget <= 0) {
					sendGoalMessage(ctx, 'Usage: `/goal budget <tokens>` (e.g. `/goal budget 200000`)', {
						action: 'budget'
					})
					return
				}
				if (!currentGoal) {
					sendGoalMessage(ctx, 'No active goal. Set a goal first with `/goal <objective>`.', {
						action: 'budget'
					})
					return
				}
				currentGoal = updateGoalState(currentGoal, { tokenBudget: budget })
				saveState(currentGoal)
				updateStatus(ctx)
				sendGoalMessage(ctx, `💰 Token budget updated to ${formatTokens(budget)} tokens.`, {
					action: 'budget'
				})
				return
			}

			// If objective is provided as argument
			if (input.length > 0) {
				currentGoal = createGoal(input)
				saveState(currentGoal)
				updateStatus(ctx)
				sendGoalMessage(ctx, `🎯 Goal initiated: "${currentGoal.objective}"`, { action: 'start' })
				isContinuationTurn = true
				pi.sendUserMessage(`Start working on goal: "${currentGoal.objective}".`)
				return
			}

			// Interactive menu when /goal is called with no args
			if (!ctx.hasUI) {
				sendGoalMessage(
					ctx,
					'Usage: `/goal <objective> | status | pause | resume | clear | edit | budget`',
					{ action: 'help' }
				)
				return
			}

			if (!currentGoal) {
				const entered = await ctx.ui.input('Enter goal objective:')
				if (entered && entered.trim()) {
					currentGoal = createGoal(entered.trim())
					saveState(currentGoal)
					updateStatus(ctx)
					sendGoalMessage(ctx, `🎯 Goal initiated: "${currentGoal.objective}"`, { action: 'start' })
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
				'📊 View Goal Status & Progress',
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
				sendGoalMessage(ctx, '⏸️ Goal paused.', { action: 'pause' })
			} else if (picked === '▶️  Resume goal') {
				currentGoal = updateGoalState(currentGoal, {
					status: 'active',
					lastReason: undefined
				})
				saveState(currentGoal)
				updateStatus(ctx)
				sendGoalMessage(ctx, '▶️ Resuming goal execution.', { action: 'resume' })
				isContinuationTurn = true
				pi.sendUserMessage(`Resume goal (turn ${currentGoal.turns + 1}).`)
			} else if (picked?.startsWith('📊 View')) {
				const details = [
					`### 🎯 Goal Status:`,
					`• Objective: "${currentGoal.objective}"`,
					`• Status: ${currentGoal.status.toUpperCase()} (Turn ${currentGoal.turns})`,
					`• Token Budget: ${budgetText}`,
					`• Elapsed Time: ${durationText}`
				].join('\n')
				sendGoalMessage(ctx, details, { action: 'status' })
			} else if (picked === '✏️  Edit objective') {
				const edit = await ctx.ui.input('Edit objective:', currentGoal.objective)
				if (edit && edit.trim()) {
					currentGoal = updateGoalState(currentGoal, { objective: edit.trim() })
					saveState(currentGoal)
					updateStatus(ctx)
					sendGoalMessage(ctx, `✏️ Objective updated: "${currentGoal.objective}"`, {
						action: 'edit'
					})
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
						sendGoalMessage(ctx, `💰 Token budget set to ${formatTokens(b)}.`, { action: 'budget' })
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
					sendGoalMessage(ctx, '🗑️ Active goal cleared.', { action: 'clear' })
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
