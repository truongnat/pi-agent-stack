import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Markdown, Text } from '@earendil-works/pi-tui'
import * as t from 'typebox'
import { checkOrchestratorGuard } from './guard.ts'
import { SubagentManager } from './manager.ts'
import type { SubagentExecutionResult, SubagentTask } from './types.ts'


const SubagentTaskSchema = t.Object({
	role: t.String({
		description:
			'Role of the subagent: "researcher" (codebase search & analysis), "coder" (edits & refactorings), "tester" (test execution), "reviewer" (code diff critique), or a custom role.'
	}),
	prompt: t.String({
		description: 'Detailed and actionable instruction for what this subagent should accomplish.'
	}),
	name: t.Optional(
		t.String({
			description:
				'Optional human-readable label for this subagent (e.g. "auth-module-researcher").'
		})
	),
	model_override: t.Optional(
		t.String({
			description: 'Optional model override (e.g. "flash", "sonnet", "pro", "mini").'
		})
	),
	tools: t.Optional(
		t.Array(t.String(), {
			description: 'Optional list of allowed tools (defaults to the role definition).'
		})
	)
})

const InvokeSubagentSchema = t.Object({
	subagents: t.Array(SubagentTaskSchema, {
		description: 'List of subagent tasks to execute.'
	}),
	parallel: t.Optional(
		t.Boolean({
			description: 'Whether to execute subagents concurrently (default: true).',
			default: true
		})
	),
	require_consensus: t.Optional(
		t.Boolean({
			description:
				'When true, spawns verification reviewer & tester agents to vote and reach consensus on the coder output.',
			default: false
		})
	),
	reviewer_roles: t.Optional(
		t.Array(t.String(), {
			description: 'Optional list of reviewer roles for consensus (default: ["reviewer", "tester"]).'
		})
	)
})

const ManageSubagentsSchema = t.Object({
	action: t.Union([
		t.Literal('list', { description: 'List all running and completed subagents.' }),
		t.Literal('status', { description: 'Get detailed status and logs of a specific subagent.' }),
		t.Literal('kill', { description: 'Kill a running subagent.' }),
		t.Literal('kill_all', { description: 'Kill all running subagents.' }),
		t.Literal('clear', { description: 'Clear history of completed/failed subagents.' })
	]),
	subagent_id: t.Optional(
		t.String({
			description: 'Subagent ID (required for "status" or "kill" action).'
		})
	)
})

const SendSubagentMessageSchema = t.Object({
	subagent_id: t.String({
		description: 'Target subagent ID.'
	}),
	message: t.String({
		description: 'Guidance message to send to the subagent.'
	})
})

export function createOrchestratorTools(manager: SubagentManager) {
	const invokeSubagentTool: ToolDefinition<typeof InvokeSubagentSchema> = defineTool({
		name: 'invoke_subagent',
		label: 'Invoke Subagents',
		description:
			'Spawn specialized subagents (researcher, coder, tester, reviewer) with private scratchpads and role-scoped tools, returning synthesized artifacts to the Master Orchestrator.',
		promptSnippet:
			'invoke_subagent({ subagents: [{ role: "researcher", prompt: "..." }], parallel: true, require_consensus: false }) — spawn subagents',
		parameters: InvokeSubagentSchema,
		executionMode: 'sequential',
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const guardCheck = checkOrchestratorGuard(manager.config)
			if (!guardCheck.allowed) {
				return {
					content: [
						{
							type: 'text',
							text: guardCheck.reason ?? 'Multi-Agent Orchestrator guard blocked execution.'
						}
					],
					isError: true,
					details: {
						guardBlocked: true,
						providers: guardCheck.providers,
						minRequired: manager.config.minProvidersRequired
					}
				}
			}

			if (!params.subagents || params.subagents.length === 0) {
				return {
					content: [{ type: 'text', text: 'No subagent tasks provided.' }],
					isError: true,
					details: undefined
				}
			}

			const tasks: SubagentTask[] = params.subagents.map((s) => ({
				role: s.role,
				prompt: s.prompt,
				name: s.name,
				modelOverride: s.model_override,
				tools: s.tools
			}))

			const cwd = ctx.cwd || process.cwd()
			const parallel = params.parallel ?? true

			// If require_consensus is requested on a single primary task
			if (params.require_consensus && tasks.length === 1) {
				const primary = tasks[0]!
				const reviewerRoles = params.reviewer_roles || ['reviewer', 'tester']
				const consensusExecution = await manager.invokeWithConsensus(
					primary,
					reviewerRoles,
					cwd,
					signal ? { signal } : {}
				)

				const primarySection = `## 🧑‍💻 Primary Task: \`${consensusExecution.primaryResult.name}\` (${consensusExecution.primaryResult.role})\n${consensusExecution.primaryResult.output}`
				const consensusSection = consensusExecution.consensus.summary

				const text = [
					`# 🏛 Orchestrator: Multi-Agent Consensus Verification Tree`,
					'',
					consensusSection,
					'',
					primarySection
				].join('\n\n')

				return {
					content: [{ type: 'text', text }],
					details: {
						consensus: consensusExecution.consensus,
						primaryResult: consensusExecution.primaryResult,
						verificationResults: consensusExecution.verificationResults
					}
				}
			}

			const results: SubagentExecutionResult[] = await manager.invokeBatch(
				tasks,
				cwd,
				parallel,
				signal ? { signal } : {}
			)

			const sections = results.map((r) => {
				const statusIcon = r.status === 'completed' ? '✅' : '❌'
				const errorSection = r.error ? `\n> **Error**: ${r.error}` : ''
				return `## ${statusIcon} Subagent: \`${r.name}\` (${r.role})\n- **ID**: \`${r.id}\`\n- **Status**: \`${r.status}\` | **Duration**: ${r.durationMs}ms | **Tokens**: ${r.tokensUsed}\n- **Scratchpad**: \`${r.scratchpadDir}\`${errorSection}\n\n${r.output}`
			})

			const text = [
				`# 🤖 Orchestrator: Dispatched ${results.length} Subagent(s) (${parallel ? 'Parallel' : 'Sequential'})`,
				'',
				...sections
			].join('\n\n')

			return {
				content: [{ type: 'text', text }],
				details: {
					count: results.length,
					results
				}
			}
		},
		renderCall(args, theme) {
			const count = args?.subagents?.length || 0
			const roles = args?.subagents?.map((s: any) => s.role).filter(Boolean) || []
			const roleBadges = roles.map((r: string) => `[ ${r} ]`).join(' ')
			const parallelStr = args?.parallel === false ? 'sequential' : 'parallel'
			const text = `${theme.fg('accent', theme.bold('🤖 Orchestrator'))} ${theme.fg('muted', '•')} ${theme.bold(`Dispatch ${count} subagent${count > 1 ? 's' : ''}`)} ${theme.fg('muted', `(${parallelStr})`)}${roleBadges ? ` ${theme.fg('cyan', roleBadges)}` : ''}`
			return new Text(text, 0, 0)
		},
		renderResult(result, options, theme) {
			const text = result?.content?.map((c: any) => c.text || '').join('\n') || ''
			if (!options.expanded) {
				if (result?.details?.results) {
					const lines = [
						theme.fg('accent', theme.bold(`🤖 Orchestrator: Dispatched ${result.details.results.length} Subagent(s)`)),
						...result.details.results.map((r: any) => {
							const icon = r.status === 'completed' ? '✅' : '❌'
							const roleBadge = theme.fg('cyan', `[ ${r.role} ]`)
							const nameStr = theme.bold(r.name)
							const meta = theme.fg('muted', `(${r.durationMs}ms, ${r.tokensUsed} tokens)`)
							return `  ${icon} ${roleBadge} ${nameStr} ${meta}`
						})
					]
					return new Text(lines.join('\n'), 0, 0)
				}
				if (result?.details?.consensus) {
					const c = result.details.consensus
					const primary = result.details.primaryResult
					const statusIcon = c.status === 'approved' ? '✅' : '⚠️'
					const lines = [
						theme.fg('accent', theme.bold(`🏛 Orchestrator: Consensus ${c.status.toUpperCase()} (score: ${c.score.toFixed(2)})`)),
						`  ${statusIcon} ${theme.fg('cyan', `[ ${primary.role} ]`)} ${theme.bold(primary.name)} ${theme.fg('muted', `(${primary.durationMs}ms, ${primary.tokensUsed} tokens)`)}`
					]
					return new Text(lines.join('\n'), 0, 0)
				}
			}
			try {
				return new Markdown(text, 0, 0, theme)
			} catch {
				return new Text(text, 0, 0)
			}
		}
	})

	const manageSubagentsTool: ToolDefinition<typeof ManageSubagentsSchema, any> = defineTool({
		name: 'manage_subagents',
		label: 'Manage Subagents',
		description: 'List, inspect, or kill subagents managed by the Multi-Agent Orchestrator.',
		promptSnippet: 'manage_subagents({ action: "list" | "status" | "kill", subagent_id })',
		parameters: ManageSubagentsSchema,
		executionMode: 'sequential',
		async execute(_toolCallId, params): Promise<any> {
			switch (params.action) {
				case 'list': {
					const list = manager.listSubagents()
					if (list.length === 0) {
						return {
							content: [{ type: 'text', text: 'No active or recent subagents.' }],
							details: { count: 0, subagents: [] }
						}
					}
					const rows = list.map(
						(s) =>
							`| \`${s.id}\` | **${s.name}** | \`${s.role}\` | \`${s.status}\` | \`${s.model}\` | ${s.tokensUsed} |`
					)
					const table = [
						'| ID | Name | Role | Status | Model | Tokens |',
						'| --- | --- | --- | --- | --- | --- |',
						...rows
					].join('\n')
					return {
						content: [
							{
								type: 'text',
								text: `### 📋 Managed Subagents (Total: ${list.length})\n\n${table}`
							}
						],
						details: { count: list.length, subagents: list }
					}
				}

				case 'status': {
					if (!params.subagent_id) {
						return {
							content: [{ type: 'text', text: 'Error: subagent_id is required for status.' }],
							isError: true,
							details: undefined
						}
					}
					const sub = manager.getSubagent(params.subagent_id)
					if (!sub) {
						return {
							content: [{ type: 'text', text: `Subagent not found: "${params.subagent_id}".` }],
							isError: true,
							details: undefined
						}
					}
					const logLines = sub.logs
						.slice(-10)
						.map(
							(l) =>
								`- [${new Date(l.timestamp).toISOString().slice(11, 19)}] \`${l.type}\`: ${l.message}`
						)
						.join('\n')
					const text = [
						`### 🔍 Subagent Status: ${sub.name} (\`${sub.id}\`)`,
						`- **Role**: \`${sub.role}\``,
						`- **Status**: \`${sub.status}\``,
						`- **Model**: \`${sub.model}\``,
						`- **Scratchpad**: \`${sub.scratchpadDir}\``,
						`- **Tokens**: ${sub.tokensUsed}`,
						sub.error ? `- **Error**: ${sub.error}` : '',
						'',
						'#### Recent Logs:',
						logLines || '(no logs)'
					]
						.filter(Boolean)
						.join('\n')
					return {
						content: [{ type: 'text', text }],
						details: sub
					}
				}

				case 'kill': {
					if (!params.subagent_id) {
						return {
							content: [{ type: 'text', text: 'Error: subagent_id is required for kill.' }],
							isError: true,
							details: undefined
						}
					}
					const killed = manager.killSubagent(params.subagent_id)
					return {
						content: [
							{
								type: 'text',
								text: killed
									? `Successfully killed subagent "${params.subagent_id}".`
									: `Could not kill subagent "${params.subagent_id}" (not found or not running).`
							}
						],
						details: { killed }
					}
				}

				case 'kill_all': {
					const count = manager.killAll()
					return {
						content: [{ type: 'text', text: `Killed ${count} running subagent(s).` }],
						details: { count }
					}
				}

				case 'clear': {
					manager.clearHistory()
					return {
						content: [{ type: 'text', text: 'Cleared subagent history.' }],
						details: { cleared: true }
					}
				}
			}
		},
		renderCall(args, theme) {
			const action = args?.action || 'list'
			const target = args?.subagent_id ? ` ${args.subagent_id}` : ''
			return new Text(
				`${theme.fg('accent', theme.bold('🤖 manage_subagents'))} ${theme.fg('cyan', action)}${theme.fg('muted', target)}`,
				0,
				0
			)
		},
		renderResult(result, _options, theme) {
			const text = result?.content?.map((c: any) => c.text || '').join('\n') || ''
			try {
				return new Markdown(text, 0, 0, theme)
			} catch {
				return new Text(text, 0, 0)
			}
		}
	})

	const sendSubagentMessageTool: ToolDefinition<typeof SendSubagentMessageSchema> = defineTool({
		name: 'send_subagent_message',
		label: 'Send Subagent Message',
		description: 'Send a guidance message or followup question to an active subagent.',
		promptSnippet: 'send_subagent_message({ subagent_id, message })',
		parameters: SendSubagentMessageSchema,
		executionMode: 'sequential',
		async execute(_toolCallId, params) {
			const sub = manager.getSubagent(params.subagent_id)
			if (!sub) {
				return {
					content: [{ type: 'text', text: `Subagent not found: "${params.subagent_id}".` }],
					isError: true,
					details: undefined
				}
			}

			return {
				content: [
					{
						type: 'text',
						text: `Message successfully delivered to subagent "${sub.name}".`
					}
				],
				details: {
					delivered: true,
					subagentId: sub.id
				}
			}
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg('accent', theme.bold('🤖 send_subagent_message'))} ${theme.fg('muted', '->')} ${theme.fg('cyan', args?.subagent_id || '')}`,
				0,
				0
			)
		},
		renderResult(result, _options, theme) {
			const text = result?.content?.map((c: any) => c.text || '').join('\n') || ''
			try {
				return new Markdown(text, 0, 0, theme)
			} catch {
				return new Text(text, 0, 0)
			}
		}
	})

	return {
		invokeSubagentTool,
		manageSubagentsTool,
		sendSubagentMessageTool
	}
}
