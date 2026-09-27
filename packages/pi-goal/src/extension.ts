import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { Box, Markdown, Text } from '@earendil-works/pi-tui'

import { evaluateGoalWithJev } from './evaluator.ts'
import { applyTurnMetrics, evaluateStopRules } from './loop.ts'
import {
	buildBudgetLimitPrompt,
	buildContinuationPrompt,
	buildInjectPrompt,
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

	/** Start a turn when idle; queue steer/followUp when the agent is already running (reload, overlap). */
	function sendLoopMessage(
		ctx: ExtensionContext | undefined,
		text: string,
		whenBusy: 'steer' | 'followUp' = 'followUp'
	) {
		const idle = !ctx || typeof ctx.isIdle !== 'function' || ctx.isIdle()
		const result = idle
			? pi.sendUserMessage(text)
			: pi.sendUserMessage(text, { deliverAs: whenBusy })
		const pending = result as Promise<void> | void
		if (pending && typeof pending.catch === 'function') {
			pending.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err)
				if (/already processing/i.test(msg)) {
					void pi.sendUserMessage(text, { deliverAs: whenBusy })
				}
			})
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
				typeof message.content === 'string'
					? message.content
					: JSON.stringify(message.content, null, 2)
			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(lines.join('\n'), 0, 0))

			if (contentStr.trim()) {
				let displayContent = contentStr
				if (!expanded) {
					const rawLines = contentStr.split('\n')
					if (rawLines.length > 8) {
						displayContent =
							rawLines.slice(0, 8).join('\n') +
							`\n\n*... and ${rawLines.length - 8} more lines (expand to view)*`
					}
				}
				const mdTheme = getMarkdownTheme()
				box.addChild(new Markdown(displayContent, 1, 0, mdTheme))
			}
			return box
		})

		pi.registerMessageRenderer('goal-reminder', (message, { outputPad }, theme) => {
			const badge = theme.fg('warning', theme.bold('[ 🎯 GOAL REMINDER ]'))
			const header = `${badge} ${theme.bold('Active Goal Tracking')}`
			const lines = [header]
			if (currentGoal) {
				lines.push(theme.fg('muted', `  Active Objective: "${currentGoal.objective}"`))
			}
			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(lines.join('\n'), 0, 0))
			const contentStr = typeof message.content === 'string' ? message.content : ''
			if (contentStr.trim()) {
				const mdTheme = getMarkdownTheme()
				box.addChild(new Markdown(contentStr, 1, 0, mdTheme))
			}
			return box
		})
	}

	// ── Option A: Ctrl+Enter keyboard shortcut ───────────────────────────────
	// Explicit inject: user presses Ctrl+Enter to immediately push editor text
	// into the running goal loop as a steer (mid-streaming inject).
	// Ctrl+Shift+Enter queues it as a followUp (next-turn inject).
	pi.registerShortcut('ctrl+enter', {
		description: '💉 Inject editor text immediately into active goal loop (steer)',
		handler: (ctx) => {
			if (!currentGoal || currentGoal.status !== 'active') {
				ctx.ui.notify('No active goal. Start one with /goal <objective>.', 'warning')
				return
			}
			const text = ctx.ui.getEditorText().trim()
			if (!text) {
				ctx.ui.notify('Editor is empty — nothing to inject.', 'warning')
				return
			}
			ctx.ui.setEditorText('')
			isContinuationTurn = true
			lastEvaluatorNote = `[Ctrl+Enter inject]: ${text}`
			pi.sendUserMessage(buildInjectPrompt(currentGoal, text), {
				deliverAs: 'steer'
			})
			sendGoalMessage(
				ctx,
				`💉 Ctrl+Enter → injected into goal loop (steer): "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
				{ action: 'inject', via: 'ctrl+enter' }
			)
		}
	})

	pi.registerShortcut('ctrl+shift+enter', {
		description: '💉 Inject editor text into goal loop as follow-up (next turn)',
		handler: (ctx) => {
			if (!currentGoal || currentGoal.status !== 'active') {
				ctx.ui.notify('No active goal. Start one with /goal <objective>.', 'warning')
				return
			}
			const text = ctx.ui.getEditorText().trim()
			if (!text) {
				ctx.ui.notify('Editor is empty — nothing to inject.', 'warning')
				return
			}
			ctx.ui.setEditorText('')
			isContinuationTurn = true
			lastEvaluatorNote = `[Ctrl+Shift+Enter inject — next turn]: ${text}`
			pi.sendUserMessage(buildInjectPrompt(currentGoal, text), {
				deliverAs: 'followUp'
			})
			sendGoalMessage(
				ctx,
				`💉 Ctrl+Shift+Enter → queued for next turn: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
				{ action: 'inject', via: 'ctrl+shift+enter' }
			)
		}
	})

	// 2. Lifecycle Hooks

	// ── Option B: InputEvent intercept ──────────────────────────────────────
	// When the goal loop is active and the user sends a message that will be
	// delivered into the *current* streaming turn (streamingBehavior === 'steer'),
	// we transparently wrap the raw text in a buildInjectPrompt envelope so the
	// agent sees proper goal context around it — the user just types normally.
	//
	// When the agent is idle (between autonomous turns), messages arrive with no
	// streamingBehavior; those are handled by the before_agent_start reminder.
	// We leave those untransformed here and let the reminder hook do its work.
	pi.on('input', (event, ctx) => {
		if (!currentGoal || currentGoal.status !== 'active') return
		if (event.source !== 'interactive') return
		if (!event.text.trim()) return

		const isStreamingSteer = !ctx.isIdle() && event.streamingBehavior === 'steer'
		if (!isStreamingSteer) return

		// Agent is running right now: wrap text as an inject prompt so the model
		// gets proper context (objective + turn counter) alongside the user text.
		lastEvaluatorNote = `[User mid-stream inject]: ${event.text.trim()}`
		return {
			action: 'transform' as const,
			text: buildInjectPrompt(currentGoal, event.text.trim())
		}
	})

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

	function processMessageSignals(msg: any) {
		if (!msg) return
		if (msg.role === 'assistant' || msg.type === 'assistant') {
			if (typeof msg.content === 'string' && msg.content.trim()) {
				turnHasText = true
				lastAssistantText += msg.content
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
						turnHasText = true
						lastAssistantText += part.text
					}
					if (part?.type === 'thinking' || typeof part?.thinking === 'string') {
						turnHasThinking = true
					}
					if (part?.type === 'toolCall' || part?.type === 'tool_use' || part?.toolCallId) {
						turnHasToolCalls = true
					}
				}
			}
		}
	}

	pi.on('message_update', (event: any) => {
		processMessageSignals(event?.message)
	})

	pi.on('message_end', (event: any) => {
		processMessageSignals(event?.message)
	})

	pi.on('tool_call', (event, _ctx) => {
		turnHasToolCalls = true
		const inputStr = JSON.stringify(event.input)
		const shortInput = inputStr.length > 80 ? `${inputStr.slice(0, 80)}…` : inputStr
		lastToolSummary.push(`${event.toolName}(${shortInput})`)
	})

	pi.on('agent_end', (event: any, ctx) => {
		// Ensure messages are fully inspected
		if (Array.isArray(event?.messages)) {
			for (const msg of event.messages) {
				processMessageSignals(msg)
			}
		}

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
				toolSummary: lastToolSummary.join('; '),
				reason: metrics.selfReportedReason
			})
			if (!evaluatorResult.met && evaluatorResult.confidence >= 0.6) {
				lastEvaluatorNote = `Goal continuation required: ${evaluatorResult.reason}`
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
			lastMetrics = null

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
			lastMetrics = null
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[Goal Turn ${currentGoal.turns}]: +${(metrics.inputTokens + metrics.outputTokens).toLocaleString()} tokens · Total Tokens: ${currentGoal.tokensUsed.toLocaleString()} (~${formatTokens(currentGoal.tokensUsed)})\n⚠️ Token budget reached. Starting final wrap-up turn...`,
					'warning'
				)
			}
			sendLoopMessage(ctx, 'Complete the wrap-up summary for the token budget limit.', 'followUp')
			return
		}

		// Continue goal loop with decision reason if available
		if (decision.reason && !lastEvaluatorNote) {
			lastEvaluatorNote = decision.reason
		}
		lastMetrics = null

		if (ctx.hasUI) {
			const turnTokens = metrics.inputTokens + metrics.outputTokens
			ctx.ui.notify(
				`[Goal Turn ${currentGoal.turns}]: +${turnTokens.toLocaleString()} tokens · Total: ${currentGoal.tokensUsed.toLocaleString()} tokens (~${formatTokens(currentGoal.tokensUsed)})`,
				'info'
			)
		}
		isContinuationTurn = true
		sendLoopMessage(ctx, `Continue the goal (turn ${currentGoal.turns + 1}).`, 'followUp')
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
			'Autonomous goal loop: /goal <objective> | status | pause | resume | retry | clear | edit | inject | budget',
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

			if (input.startsWith('resume') || input.startsWith('retry')) {
				if (!currentGoal) {
					sendGoalMessage(ctx, 'No goal to resume. Use `/goal <objective>` to create one.', {
						action: 'resume'
					})
					return
				}
				currentGoal = updateGoalState(currentGoal, {
					status: 'active',
					sameBlockerTurns: 0,
					consecutiveErrors: 0,
					emptyTurns: 0,
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
				sendLoopMessage(ctx, `Resume goal (turn ${currentGoal.turns + 1}).`, 'followUp')
				return
			}

			if (input.startsWith('clear')) {
				currentGoal = null
				updateStatus(ctx)
				sendGoalMessage(ctx, '🗑️ Active goal cleared.', { action: 'clear' })
				return
			}

			if (input.startsWith('inject ') || input === 'inject') {
				const msg = input.replace(/^inject\s*/, '').trim()
				if (!msg) {
					sendGoalMessage(
						ctx,
						'Usage: `/goal inject <message>` — immediately injects a message into the running goal loop.',
						{ action: 'inject' }
					)
					return
				}
				if (!currentGoal || currentGoal.status !== 'active') {
					sendGoalMessage(
						ctx,
						'⚠️ No active goal to inject into. Start a goal with `/goal <objective>` first.',
						{ action: 'inject' }
					)
					return
				}
				// Mark next turn as a continuation so before_agent_start injects the steering block
				isContinuationTurn = true
				// Carry the injection text as an evaluator note so the steering block also sees it
				lastEvaluatorNote = `[User Injection]: ${msg}`
				// Send the full inject prompt as the user message that triggers the next agent turn
				sendLoopMessage(ctx, buildInjectPrompt(currentGoal, msg), 'steer')
				sendGoalMessage(ctx, `💉 Injected into goal loop: "${msg}"`, { action: 'inject' })
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
						sendLoopMessage(ctx, buildObjectiveUpdatedPrompt(old, newObjective), 'steer')
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
				sendLoopMessage(ctx, `Start working on goal: "${currentGoal.objective}".`, 'followUp')
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
					sendLoopMessage(ctx, `Start working on goal: "${currentGoal.objective}".`, 'followUp')
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
				sendLoopMessage(ctx, `Resume goal (turn ${currentGoal.turns + 1}).`, 'followUp')
			} else if (picked?.startsWith('📊 View')) {
				const details = [
					`### 🎯 Goal Status`,
					'',
					`- **Objective**: "${currentGoal.objective}"`,
					`- **Status**: \`${currentGoal.status.toUpperCase()}\` (Turn ${currentGoal.turns})`,
					`- **Token Budget**: ${budgetText}`,
					`- **Elapsed Time**: ${durationText}`
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
