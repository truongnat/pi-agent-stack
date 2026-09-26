import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { loadOrchestratorConfig } from './config.ts'
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

	// Expose global bridge
	;(globalThis as any).piAgentStackOrchestrator = {
		isReady: () => checkOrchestratorGuard(manager.config).allowed,
		getProviders: () => checkOrchestratorGuard(manager.config).providers,
		listSubagents: () => manager.listSubagents()
	}

	// 2. Lifecycle Hooks
	pi.on('before_agent_start', (event, ctx) => {
		const guard = checkOrchestratorGuard(manager.config)
		if (!guard.allowed) return undefined

		const providerList = guard.providers.join(', ')
		const orchestratorBlock = [
			'[Multi-Agent Orchestrator Steering]',
			`• Status: Active (${guard.providers.length} ready providers: ${providerList})`,
			'• Subagent Delegation: You have autonomous subagents available via `invoke_subagent`.',
			'• When to Delegate:',
			'  - Broad codebase search / multi-file research: dispatch `researcher` subagent to search in background.',
			'  - Bug diagnosis across monorepos: dispatch `debugger` subagent to isolate logs and stack traces.',
			'  - Parallel tasks: run multiple sub-tasks concurrently across providers (e.g. testing + auditing).',
			'• Available Roles: researcher, debugger, coder, reviewer (or custom role name).'
		].join('\n')

		return {
			message: { customType: 'orchestrator', content: orchestratorBlock, display: false }
		}
	})

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
				ctx.ui.notify(info, 'info')
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
					`│ • Active Workers: ${running.length} running, ${manager.listSubagents().length} total in session`.padEnd(70) + '│',
					'└─────────────────────────────────────────────────────────────────────┘'
				].join('\n')
				ctx.ui.notify(dagTree, guard.allowed ? 'info' : 'warning')
				return
			}

			if (input === 'roster') {
				const roles = Object.values(DEFAULT_ROSTER).map(
					(r) =>
						`• **${r.name}** (${r.label})\n  - *Model Tier*: \`${r.defaultModelTier}\`\n  - *Tools*: [${r.allowedTools.join(', ')}]\n  - *Description*: ${r.description}`
				)
				ctx.ui.notify(`### 👥 Available Subagent Roster:\n\n${roles.join('\n\n')}`, 'info')
				return
			}

			if (input === 'list') {
				const list = manager.listSubagents()
				if (list.length === 0) {
					ctx.ui.notify('No active or recent subagents in orchestrator.', 'info')
					return
				}
				const rows = list.map(
					(s) =>
						`• **${s.name}** (\`${s.role}\`) — *${s.status.toUpperCase()}* (Model: \`${s.model}\`, Tokens: ${s.tokensUsed})`
				)
				ctx.ui.notify(
					`### 🤖 Subagent History (Total: ${list.length}):\n\n${rows.join('\n')}`,
					'info'
				)
				return
			}

			if (input.startsWith('kill ')) {
				const id = input.replace('kill ', '').trim()
				const ok = manager.killSubagent(id)
				updateStatus(ctx)
				ctx.ui.notify(
					ok ? `Subagent "${id}" killed.` : `Could not kill subagent "${id}".`,
					ok ? 'info' : 'warning'
				)
				return
			}

			if (input === 'kill-all') {
				const count = manager.killAll()
				updateStatus(ctx)
				ctx.ui.notify(`Killed ${count} running subagents.`, 'info')
				return
			}

			if (input === 'clear') {
				manager.clearHistory()
				updateStatus(ctx)
				ctx.ui.notify('Cleared subagent history.', 'info')
				return
			}

			// Interactive UI menu
			if (!ctx.hasUI) {
				ctx.ui.notify('Usage: /agents [dag|status|list|roster|kill <id>|kill-all|clear]', 'info')
				return
			}

			const list = manager.listSubagents()
			const running = list.filter((s) => s.status === 'running')
			const guard = checkOrchestratorGuard(manager.config)

			const menuItems = [
				`📊 Visual DAG Supervisor & Guard (${guard.allowed ? 'Ready' : 'Guard Alert'})`,
				`📋 List Subagents (${list.length} total, ${running.length} running)`,
				'👥 View Available Roster',
				'🛑 Kill All Running Subagents',
				'🗑️  Clear Subagent History',
				'❌ Close Menu'
			]

			const picked = await ctx.ui.select(
				`Multi-Agent DAG Supervisor (Ember UX)\nActive Workers: ${running.length} running · Providers: ${guard.providers.length}`,
				menuItems
			)

			if (!picked) return

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
					`│ • Active Workers: ${running.length} running, ${list.length} total in session`.padEnd(70) + '│',
					'└─────────────────────────────────────────────────────────────────────┘'
				].join('\n')
				ctx.ui.notify(dagTree, 'info')
			} else if (picked.startsWith('📋 List')) {
				if (list.length === 0) {
					ctx.ui.notify('No subagents found.', 'info')
					return
				}
				const rows = list.map(
					(s) => `• **${s.name}** (\`${s.role}\`) — *${s.status}* | \`${s.id}\``
				)
				ctx.ui.notify(`### Subagents:\n\n${rows.join('\n')}`, 'info')
			} else if (picked.startsWith('👥 View')) {
				const roles = Object.values(DEFAULT_ROSTER).map(
					(r) => `• **${r.name}** (${r.label}) [Model: \`${r.defaultModelTier}\`]`
				)
				ctx.ui.notify(`### Roster:\n\n${roles.join('\n')}`, 'info')
			} else if (picked.startsWith('🛑 Kill All')) {
				const count = manager.killAll()
				updateStatus(ctx)
				ctx.ui.notify(`Killed ${count} subagents.`, 'info')
			} else if (picked.startsWith('🗑️  Clear')) {
				manager.clearHistory()
				updateStatus(ctx)
				ctx.ui.notify('Cleared subagent history.', 'info')
			}
		}
	})

	return { manager }
}
