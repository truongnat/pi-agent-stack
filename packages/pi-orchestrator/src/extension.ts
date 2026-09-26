import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { Box, Markdown, Text } from '@earendil-works/pi-tui'
import { loadOrchestratorConfig, saveOrchestratorConfig } from './config.ts'
import { checkOrchestratorGuard } from './guard.ts'
import { SubagentManager } from './manager.ts'
import { DEFAULT_ROSTER } from './roster.ts'
import { createOrchestratorTools } from './tools.ts'

export function createOrchestratorExtension(pi: ExtensionAPI) {
	const manager = new SubagentManager()

	pi.on('session_start', () => {
		manager.config = loadOrchestratorConfig()
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
		createOrchestratorTools(manager)

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
				const mdTheme = getMarkdownTheme()
				box.addChild(new Markdown(displayContent, 1, 0, mdTheme))
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
				const mdTheme = getMarkdownTheme()
				box.addChild(new Markdown(displayContent, 1, 0, mdTheme))
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
			'   - 📚 `researcher`: Read-only file inspection, repository discovery, code excerpts, and architecture investigation.',
			'   - 🔍 `debugger`: Isolates runtime crashes, error logs, trace lines, and root-cause analysis.',
			'   - 🧑‍💻 `coder`: Precise multi-file implementations, edits, and refactorings.',
			'   - 🧪 `tester`: Executes test suites, linters, and verification checks.',
			'   - 🔍 `reviewer`: Audits git diffs, security standards, and code quality.',
			'3. **END-TO-END EXECUTION LIFECYCLE (DO NOT STALL)**:',
			'   - When the user asks to fix/handle/implement an issue (e.g. "xử lý", "fix", "sửa", "làm"), DO NOT just analyze and stop!',
			'   - Research is only Step 1. You MUST immediately dispatch a `coder` subagent (or apply edits) to implement the fix, followed by a `tester` subagent to verify.',
			'   - NEVER end your turn saying "Chưa sửa mã nguồn..." when asked to fix or handle a task.',
			'   - Do NOT run redundant serial read/find/grep calls on files that subagents have already analyzed in their scratchpads.',
			'4. **CONCURRENCY & CONSENSUS**:',
			'   - Use `parallel: true` when subagent tasks are independent (e.g. parallel research across multiple modules or parallel audit).',
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
					'┌─[ 🤖 Multi-Agent DAG Supervisor (Ember UX) ]────────────────────────┐',
					'│                                                                     │',
					'│                      ┌───────────────────────┐                      │',
					'│                      │   JEV Supervisor      │                      │',
					'│                      │ (Orchestrator Leader) │                      │',
					'│                      └──────────┬────────────┘                      │',
					'│                                 │                                   │',
					'│                  ┌──────────────┴──────────────┐                    │',
					'│                  ▼                             ▼                    │',
					'│       ┌──────────────────────┐      ┌──────────────────────┐        │',
					'│       │ Worker 1: Researcher │      │ Worker 2: Debugger   │        │',
					'│       │ [Background Search]  │      │ [Trace & TDD Root]   │        │',
					'│       └──────────┬───────────┘      └──────────┬───────────┘        │',
					'│                  │                             │                    │',
					'│                  └──────────────┬──────────────┘                    │',
					'│                                 ▼                                   │',
					'│                      ┌──────────────────────┐                       │',
					'│                      │ Worker 3: Reviewer   │                       │',
					'│                      │ [Invariant Verifier] │                       │',
					'│                      └──────────────────────┘                       │',
					'│                                                                     │',
					'├─────────────────────────────────────────────────────────────────────┤',
					`│ • Provider Diversity Guard: ${guard.allowed ? '● ACTIVE (≥2 Backends)' : '○ BLOCKED (<2 Backends)'}             │`,
					`│ • Discovered Providers (${guard.providers.length}): [${providers}]`.padEnd(70) + '│',
					`│ • Active Workers: ${running.length} running, ${manager.listSubagents().length} total in session`.padEnd(
						70
					) + '│',
					'└─────────────────────────────────────────────────────────────────────┘'
				].join('\n')
				sendOrchestratorMessage(ctx, dagTree, { action: 'dag' })
				return
			}

			if (input === 'roster') {
				const roles = Object.values(DEFAULT_ROSTER).map(
					(r) =>
						`• **${r.name}** (${r.label})\n  - *Model Tier*: \`${r.defaultModelTier}\`\n  - *Tools*: [${r.allowedTools.join(', ')}]\n  - *Description*: ${r.description}`
				)
				sendOrchestratorMessage(ctx, `### 👥 Available Subagent Roster:\n\n${roles.join('\n\n')}`, {
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
				const rows = list.map(
					(s) =>
						`• **${s.name}** (\`${s.role}\`) — *${s.status.toUpperCase()}* (Model: \`${s.model}\`, Tokens: ${s.tokensUsed})`
				)
				sendOrchestratorMessage(
					ctx,
					`### 🤖 Subagent History (Total: ${list.length}):\n\n${rows.join('\n')}`,
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
				const dagTree = [
					'┌─[ 🤖 Multi-Agent DAG Supervisor (Ember UX) ]────────────────────────┐',
					'│                                                                     │',
					'│                      ┌───────────────────────┐                      │',
					'│                      │   JEV Supervisor      │                      │',
					'│                      │ (Orchestrator Leader) │                      │',
					'│                      └──────────┬────────────┘                      │',
					'│                                 │                                   │',
					'│                  ┌──────────────┴──────────────┐                    │',
					'│                  ▼                             ▼                    │',
					'│       ┌──────────────────────┐      ┌──────────────────────┐        │',
					'│       │ Worker 1: Researcher │      │ Worker 2: Debugger   │        │',
					'│       │ [Background Search]  │      │ [Trace & TDD Root]   │        │',
					'│       └──────────┬───────────┘      └──────────┬───────────┘        │',
					'│                  │                             │                    │',
					'│                  └──────────────┬──────────────┘                    │',
					'│                                 ▼                                   │',
					'│                      ┌──────────────────────┐                       │',
					'│                      │ Worker 3: Reviewer   │                       │',
					'│                      │ [Invariant Verifier] │                       │',
					'│                      └──────────────────────┘                       │',
					'│                                                                     │',
					'├─────────────────────────────────────────────────────────────────────┤',
					`│ • Provider Diversity Guard: ${guard.allowed ? '● ACTIVE (≥2 Backends)' : '○ BLOCKED (<2 Backends)'}             │`,
					`│ • Discovered Providers (${guard.providers.length}): [${providers}]`.padEnd(70) + '│',
					`│ • Active Workers: ${running.length} running, ${list.length} total in session`.padEnd(
						70
					) + '│',
					'└─────────────────────────────────────────────────────────────────────┘'
				].join('\n')
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
