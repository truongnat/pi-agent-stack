import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { loadOrchestratorConfig, saveOrchestratorConfig } from './config.ts'
import { checkOrchestratorGuard } from './guard.ts'
import { SubagentManager } from './manager.ts'
import { DEFAULT_ROSTER } from './roster.ts'
import { renderDag } from './dag.ts'
import { createOrchestratorTools, getRoleIcon } from './tools.ts'
import { renderMarkdown } from './tui-markdown.ts'
import { attachDashboard } from './dashboard.ts'
import { summarizeJsonEvent } from './json-stream.ts'

export function createOrchestratorExtension(pi: ExtensionAPI) {
	// If running as a spawned subagent worker, disable recursive orchestrator registration
	if (process.env.PI_SUBAGENT_WORKER === '1') {
		return {
			manager: null
		}
	}

	const manager = new SubagentManager()
	let dashboard: ReturnType<typeof attachDashboard> | undefined
	let dashboardSessionId = ''

	pi.on('session_start', (_event, ctx) => {
		manager.config = loadOrchestratorConfig()
		dashboard?.close()
		const sessionId = ctx.sessionManager.getSessionId() || `${process.pid}-${Date.now()}`
		const events = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === 'message')
			.flatMap((entry) => {
				const message = entry.message as any
				const text = Array.isArray(message.content)
					? message.content
							.filter((part: any) => part.type === 'text')
							.map((part: any) => part.text)
							.join('')
					: typeof message.content === 'string'
						? message.content
						: ''
				return text.trim()
					? [{ type: message.role, text: text.slice(-3000), at: Date.parse(entry.timestamp) }]
					: []
			})
			.slice(-40)
		dashboard = attachDashboard(
			{
				id: sessionId,
				title: ctx.sessionManager.getSessionName() || `Pi · ${process.pid}`,
				cwd: ctx.cwd,
				events,
				currentActivity: 'Waiting for a prompt'
			},
			(id) => {
				dashboardSessionId = id
			}
		)
		dashboardSessionId = dashboard.id
	})
	pi.on('session_info_changed', (event) => {
		const name = (event.name || '').trim()
		if (name && !/^Pi(\s*[·.]\s*|\s*)?\d*$/i.test(name)) dashboard?.update({ title: name })
	})
	pi.on('input', (event) => {
		const summary = event.text.replace(/\s+/g, ' ').trim().slice(0, 80)
		dashboard?.event('user', { text: event.text.slice(0, 4000) })
		dashboard?.event('status', { value: 'working' })
		dashboard?.update({
			...(summary ? { title: summary } : {}),
			currentActivity: 'Working on the latest prompt'
		})
	})
	pi.on('message_update', (event) => {
		if (event.message.role !== 'assistant') return
		const text = Array.isArray(event.message.content)
			? event.message.content
					.filter((part: any) => part.type === 'text')
					.map((part: any) => part.text)
					.join('')
			: ''
		if (text)
			dashboard?.update({
				preview: text.slice(-3000),
				currentActivity: text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 160)
			})
	})
	pi.on('tool_execution_start', (event) => {
		const summary = summarizeJsonEvent({
			type: 'tool_execution_start',
			toolName: event.toolName,
			args: event.args
		})
		dashboard?.event('tool', {
			name: event.toolName,
			text: summary.activity || String(event.toolName)
		})
		dashboard?.update({ currentActivity: summary.activity || String(event.toolName) })
	})
	pi.on('tool_execution_end', (event) =>
		dashboard?.event(event.isError ? 'error' : 'tool_done', {
			name: event.toolName,
			text: event.isError ? 'Tool failed' : 'Completed'
		})
	)
	pi.on('agent_settled', () => {
		dashboard?.event('status', { value: 'idle' })
		dashboard?.update({ currentActivity: 'Idle' })
	})

	// Workers run detached in their own process groups; without this they outlive Pi.
	pi.on('session_shutdown', () => {
		manager.killAll()
		dashboard?.close()
		dashboard = undefined
		dashboardSessionId = ''
	})

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return
		const running = manager.listSubagents().filter((s) => s.status === 'running')
		if (running.length > 0) {
			ctx.ui.setStatus('orchestrator', `agents: ${running.length} running`)
		} else {
			ctx.ui.setStatus('orchestrator', undefined)
		}
	}

	// 1. Register Tools
	const { invokeSubagentTool, manageSubagentsTool, sendSubagentMessageTool } =
		createOrchestratorTools(manager, () => dashboardSessionId)

	pi.registerTool(invokeSubagentTool)
	pi.registerTool(manageSubagentsTool)
	pi.registerTool(sendSubagentMessageTool)

	// Custom message renderers
	if (typeof pi.registerMessageRenderer === 'function') {
		pi.registerMessageRenderer('orchestrator', (message, { expanded, outputPad }, theme) => {
			const badge = theme.fg('accent', theme.bold('[ 🎭 ORCHESTRATOR ]'))
			const header = `${badge} ${theme.bold('Multi-Agent Supervisor & Task DAG')}`
			const contentStr =
				typeof message.content === 'string'
					? message.content
					: JSON.stringify(message.content, null, 2)
			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(header, 0, 0))

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
				box.addChild(renderMarkdown(displayContent, 1, theme, 'customMessageText'))
			}
			return box
		})

		pi.registerMessageRenderer('subagent-result', (message, { expanded, outputPad }, theme) => {
			const details = message.details as Record<string, unknown> | undefined
			const role = typeof details?.role === 'string' ? details.role.toUpperCase() : 'SUBAGENT'
			const badge = theme.fg('success', theme.bold(`[ 🤖 ${role} COMPLETE ]`))
			const header = `${badge} ${theme.bold(String(details?.agentId || 'Result'))}`
			const contentStr =
				typeof message.content === 'string'
					? message.content
					: JSON.stringify(message.content, null, 2)
			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(header, 0, 0))

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
				box.addChild(renderMarkdown(displayContent, 1, theme, 'customMessageText'))
			}
			return box
		})
	}

	// Expose global bridge
	;(globalThis as any).piAgentStackOrchestrator = {
		isReady: () => checkOrchestratorGuard(manager.config).allowed,
		getProviders: () => checkOrchestratorGuard(manager.config).providers,
		listSubagents: () => manager.listSubagents(),
		setAutoOrchestrate: (on: boolean) => {
			manager.config.alwaysOrchestrate = on
			saveOrchestratorConfig(manager.config)
		}
	}

	// 2. Lifecycle Hooks
	pi.on('before_agent_start', (_event, _ctx) => {
		const guard = checkOrchestratorGuard(manager.config)
		if (!guard.allowed) return undefined

		const providerList = guard.providers.join(', ')
		const isAuto = manager.config.alwaysOrchestrate !== false

		const orchestratorBlock = [
			'# 🤖 MANDATORY MULTI-AGENT ORCHESTRATION DIRECTIVE',
			`You are the **Lead Master Orchestrator** of Pi Agent Stack (Diversity Guard: ${guard.providers.length} ready backends: [${providerList}]).`,
			`Orchestrator Mode: ${isAuto ? '● ALWAYS-DELEGATE (DEFAULT ACTIVE)' : '○ ON-DEMAND'}`,
			'',
			'## Execution Directives:',
			'1. **DEFAULT SUBAGENT DISPATCH**: For any user request involving coding, debugging, file refactoring, testing, or multi-file research, you MUST dispatch specialized subagents via `invoke_subagent` instead of doing all heavy edits/searches directly.',
			'2. **ROLE ROSTER**:',
			'   - 📚 `researcher`: File inspection, git status/diff/log, repository discovery, code excerpts. No edits.',
			'   - 🔍 `debugger`: Isolates runtime crashes, error logs, trace lines, and root-cause analysis.',
			'   - 🧑‍💻 `coder`: Implementations and edits. Has bash. MUST self-test (compile/unit tests) in the named worktree before returning.',
			'   - 🧪 `tester`: Independent second-pass: re-run tests/linters. Does not replace the coder self-test.',
			'   - 🔍 `reviewer`: Audits git diffs, security standards, and code quality.',
			'3. **END-TO-END EXECUTION LIFECYCLE (DO NOT STALL)**:',
			'   - When the user asks to fix/handle/implement an issue (e.g. "xử lý", "fix", "sửa", "làm"), DO NOT just analyze and stop!',
			'   - Research is only Step 1. You MUST immediately dispatch a `coder` subagent to implement AND self-test. Dispatch a `tester` only as a second pass (`depends_on` the coder, or `require_consensus: true`). Do not withhold bash from the coder or ask it to skip compile.',
			'   - NEVER end your turn saying "Chưa sửa mã nguồn..." when asked to fix or handle a task.',
			'   - Do NOT run redundant serial read/find/grep calls on files that subagents have already analyzed in their scratchpads.',
			'4. **CONCURRENCY & CONSENSUS**:',
			'   - Hard cap is 20 live workers (`maxConcurrentSubagents`). Use it. Multi-file/component refactors MUST be one `invoke_subagent` with many independent tasks (`parallel: true`), not serial one-agent-at-a-time waves.',
			'   - Split by file/module: one `coder` per disjoint path. Set `isolate_workspace: true` on write-capable tasks so they do not share a checkout.',
			'   - Use `depends_on` only when a task truly needs another output. Do not chain the whole job into a sequence.',
			'   - Set `require_consensus: true` when coder changes require independent reviewer & tester voting.',
			'5. **SYNTHESIS & LANGUAGE**:',
			'   - Always synthesize reports and answers in the prompt language (Vietnamese/English). Never output in unrelated foreign languages (Mongolian, etc.).'
		].join('\n')

		return {
			message: { customType: 'orchestrator', content: orchestratorBlock, display: false }
		}
	})

	function sendOrchestratorMessage(
		ctx: ExtensionContext,
		content: string,
		details?: Record<string, unknown>
	) {
		if (typeof pi.sendMessage === 'function') {
			pi.sendMessage({
				customType: 'orchestrator',
				content,
				display: true,
				details
			} as any)
		} else {
			ctx.ui.notify(content, 'info')
		}
	}

	// 2. Register Slash Command: /agents
	pi.registerCommand('agents', {
		description:
			'Multi-Agent Orchestrator: /agents [status|dag|consensus|list|roster|kill <id>|kill-all|clear]',
		handler: async (args, ctx) => {
			const input = (args ?? '').trim()

			if (input === 'consensus') {
				const list = manager.listSubagents()
				const guard = checkOrchestratorGuard(manager.config)
				const info = [
					'### 🏛 Multi-Agent Supervisor Consensus Gate',
					`• Status: ${guard.allowed ? '● Active' : '○ Disabled (Threshold not met)'}`,
					`• Providers Diversity: ${guard.providers.length} ready ([${guard.providers.join(', ')}])`,
					`• Verification Tree: When \`require_consensus: true\` is specified in \`invoke_subagent\`, independent reviewer & tester agents execute in parallel to vote on coder changes.`,
					`• Historical Consensus Subagents: ${list.length} managed`
				].join('\n')
				sendOrchestratorMessage(ctx, info, { action: 'consensus' })
				return
			}

			if (input === 'status' || input === 'dag') {
				const guard = checkOrchestratorGuard(manager.config)
				const providers = guard.providers.length > 0 ? guard.providers.join(', ') : 'none'
				const running = manager.listSubagents().filter((s) => s.status === 'running')
				const dagTree = [
					`### 🤖 Task graph (last run)`,
					renderDag(manager.lastDag.nodes, manager.lastDag.status),
					`Providers: ${providers} · running now: ${running.length}`
				].join('\n\n')
				sendOrchestratorMessage(ctx, dagTree, { action: 'dag' })
				return
			}

			if (input === 'roster') {
				const roles = Object.values(DEFAULT_ROSTER).map(
					(r) =>
						`- ${getRoleIcon(r.name)} **${r.name.toUpperCase()}** (${r.label})\n  > - *Model Tier*: \`${r.defaultModelTier}\`\n  > - *Tools*: [${r.allowedTools.join(', ')}]\n  > - *Description*: ${r.description}`
				)
				sendOrchestratorMessage(ctx, `### 👥 Available Subagent Roster\n\n${roles.join('\n\n')}`, {
					action: 'roster'
				})
				return
			}

			if (input === 'list') {
				const list = manager.listSubagents()
				if (list.length === 0) {
					sendOrchestratorMessage(ctx, 'No active or recent subagents in orchestrator.', {
						action: 'list'
					})
					return
				}
				const rows = list.map((s) => {
					const icon = s.status === 'completed' ? '✓' : s.status === 'failed' ? '✖' : '▶'
					return `- ${icon} ${getRoleIcon(s.role)} **${s.name}** (\`${s.role}\`) — *${s.status.toUpperCase()}* (Model: \`${s.model}\`, Tokens: \`${s.tokensUsed}\`)`
				})
				sendOrchestratorMessage(
					ctx,
					`### 🤖 Subagent History (${list.length} total)\n\n${rows.join('\n')}`,
					{ action: 'list' }
				)
				return
			}

			if (input.startsWith('kill ')) {
				const id = input.replace('kill ', '').trim()
				const ok = manager.killSubagent(id)
				updateStatus(ctx)
				sendOrchestratorMessage(
					ctx,
					ok ? `✓ Subagent "${id}" killed.` : `✖ Could not kill subagent "${id}".`,
					{ action: 'kill' }
				)
				return
			}

			if (input === 'kill-all') {
				const count = manager.killAll()
				updateStatus(ctx)
				sendOrchestratorMessage(ctx, `✓ Killed ${count} running subagent(s).`, {
					action: 'kill-all'
				})
				return
			}

			if (input === 'clear') {
				manager.clearHistory()
				updateStatus(ctx)
				sendOrchestratorMessage(ctx, '✓ Cleared subagent history.', { action: 'clear' })
				return
			}

			if (input.startsWith('auto')) {
				const param = input.replace('auto', '').trim()
				if (param === 'on') {
					manager.config.alwaysOrchestrate = true
				} else if (param === 'off') {
					manager.config.alwaysOrchestrate = false
				} else {
					manager.config.alwaysOrchestrate = !manager.config.alwaysOrchestrate
				}
				saveOrchestratorConfig(manager.config)
				sendOrchestratorMessage(
					ctx,
					`Multi-Agent Auto-Orchestration is now: ${manager.config.alwaysOrchestrate ? '● ON (Lead Orchestrator active)' : '○ OFF (On-demand only)'}`,
					{ action: 'auto' }
				)
				return
			}

			// Interactive UI menu
			if (!ctx.hasUI) {
				sendOrchestratorMessage(
					ctx,
					'Usage: /agents [auto [on|off]|dag|status|list|roster|kill <id>|kill-all|clear]',
					{ action: 'help' }
				)
				return
			}

			const list = manager.listSubagents()
			const running = list.filter((s) => s.status === 'running')
			const guard = checkOrchestratorGuard(manager.config)
			const isAuto = manager.config.alwaysOrchestrate !== false

			const menuItems = [
				`⚙️  Auto-Orchestration: ${isAuto ? '● ON (Lead Mode)' : '○ OFF (Manual)'}`,
				`📊 Visual DAG Supervisor & Guard (${guard.allowed ? 'Ready' : 'Guard Alert'})`,
				`📋 List Subagents (${list.length} total, ${running.length} running)`,
				'👥 View Available Roster',
				'🛑 Kill All Running Subagents',
				'🗑️  Clear Subagent History',
				'❌ Close Menu'
			]

			const picked = await ctx.ui.select(
				`Multi-Agent DAG Supervisor (Ember UX)\nMode: ${isAuto ? '● Lead Orchestrator' : '○ Manual'} · Workers: ${running.length} running · Providers: ${guard.providers.length}`,
				menuItems
			)

			if (!picked) return

			if (picked.startsWith('⚙️  Auto-Orchestration')) {
				manager.config.alwaysOrchestrate = !isAuto
				saveOrchestratorConfig(manager.config)
				sendOrchestratorMessage(
					ctx,
					`Multi-Agent Auto-Orchestration is now: ${manager.config.alwaysOrchestrate ? '● ON (Lead Orchestrator active)' : '○ OFF (On-demand only)'}`,
					{ action: 'auto' }
				)
				return
			}

			if (picked.startsWith('📊 Visual DAG')) {
				const providers = guard.providers.length > 0 ? guard.providers.join(', ') : 'none'
				const running = manager.listSubagents().filter((s) => s.status === 'running')
				const dagTree = [
					`### 🤖 Task graph (last run)`,
					renderDag(manager.lastDag.nodes, manager.lastDag.status),
					`Providers: ${providers} · running now: ${running.length}`
				].join('\n\n')
				sendOrchestratorMessage(ctx, dagTree, { action: 'dag' })
			} else if (picked.startsWith('📋 List')) {
				if (list.length === 0) {
					sendOrchestratorMessage(ctx, 'No subagents found.', { action: 'list' })
					return
				}
				const rows = list.map(
					(s) => `- **${s.name}** (\`${s.role}\`) — *${s.status}* | \`${s.id}\``
				)
				sendOrchestratorMessage(
					ctx,
					`### 🤖 Active Subagents (${list.length})\n\n${rows.join('\n')}`,
					{ action: 'list' }
				)
			} else if (picked.startsWith('👥 View')) {
				const roles = Object.values(DEFAULT_ROSTER).map(
					(r) => `- **${r.name}** (${r.label}) [Model: \`${r.defaultModelTier}\`]`
				)
				sendOrchestratorMessage(
					ctx,
					`### 👥 Available Roster (${roles.length})\n\n${roles.join('\n')}`,
					{ action: 'roster' }
				)
			} else if (picked.startsWith('🛑 Kill All')) {
				const count = manager.killAll()
				updateStatus(ctx)
				sendOrchestratorMessage(ctx, `✓ Killed ${count} subagent(s).`, { action: 'kill-all' })
			} else if (picked.startsWith('🗑️  Clear')) {
				manager.clearHistory()
				updateStatus(ctx)
				sendOrchestratorMessage(ctx, '✓ Cleared subagent history.', { action: 'clear' })
			}
		}
	})

	return { manager }
}
