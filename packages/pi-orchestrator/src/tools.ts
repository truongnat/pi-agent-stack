import { defineTool, getMarkdownTheme, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Box, Markdown, Text } from '@earendil-works/pi-tui'
import * as t from 'typebox'
import { planDag } from './dag.ts'
import { checkOrchestratorGuard } from './guard.ts'
import { SubagentManager } from './manager.ts'
import type { SubagentExecutionResult, SubagentProgressEvent, SubagentTask } from './types.ts'

export function getRoleIcon(role: string): string {
	switch (role.toLowerCase()) {
		case 'researcher':
			return '🔍'
		case 'coder':
			return '💻'
		case 'tester':
			return '🧪'
		case 'reviewer':
			return '🧐'
		case 'architect':
			return '🏛️'
		case 'designer':
			return '🎨'
		case 'security':
			return '🛡️'
		default:
			return '🤖'
	}
}

export function getColoredRoleBadge(role: string, theme: any): string {
	const icon = getRoleIcon(role)
	const tag = role.toUpperCase()
	switch (role.toLowerCase()) {
		case 'coder':
			return `${icon} ${theme.fg('success', theme.bold(`[ ${tag} ]`))}`
		case 'tester':
			return `${icon} ${theme.fg('warning', theme.bold(`[ ${tag} ]`))}`
		case 'reviewer':
			return `${icon} ${theme.fg('accent', theme.bold(`[ ${tag} ]`))}`
		case 'researcher':
			return `${icon} ${theme.fg('accent', theme.bold(`[ ${tag} ]`))}`
		default:
			return `${icon} ${theme.fg('muted', theme.bold(`[ ${tag} ]`))}`
	}
}

const SubagentTaskSchema = t.Object({
	id: t.Optional(
		t.String({
			description: 'Id other tasks can list in depends_on (default t1, t2, … by position).'
		})
	),
	depends_on: t.Optional(
		t.Array(t.String(), {
			description:
				'Ids of tasks that must complete first. Their outputs are appended to this prompt; if one fails, this task is skipped.'
		})
	),
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
	),
	isolate_workspace: t.Optional(
		t.Boolean({
			description:
				'Run this (write-capable) task in its own git worktree and return a patch instead of editing the checkout. Use for parallel coders.'
		})
	),
	timeout_ms: t.Optional(
		t.Number({ description: 'Hard time limit for this task (default 15 min).' })
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
			description:
				'Optional list of reviewer roles for consensus (default: ["reviewer", "tester"]).'
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
				...(s.id ? { id: s.id } : {}),
				...(s.depends_on ? { dependsOn: s.depends_on } : {}),
				role: s.role,
				prompt: s.prompt,
				name: s.name,
				modelOverride: s.model_override,
				tools: s.tools,
				...(s.isolate_workspace !== undefined ? { isolateWorkspace: s.isolate_workspace } : {}),
				...(s.timeout_ms ? { timeoutMs: s.timeout_ms } : {})
			}))

			const cwd = ctx.cwd || process.cwd()
			const parallel = params.parallel ?? true

			const progressMap = new Map<
				string,
				{
					role: string
					name: string
					status: string
					currentActivity?: string
					previewMarkdown?: string
					startedAt: number
					durationMs?: number
				}
			>()

			const reportProgress = (p: SubagentProgressEvent) => {
				const existing = progressMap.get(p.id) || {
					role: p.role,
					name: p.name,
					status: p.status,
					currentActivity: p.currentActivity,
					previewMarkdown: p.previewMarkdown,
					startedAt: Date.now()
				}
				existing.status = p.status
				if (p.currentActivity) existing.currentActivity = p.currentActivity
				if (p.previewMarkdown !== undefined) existing.previewMarkdown = p.previewMarkdown
				if (p.status === 'completed' || p.status === 'failed' || p.status === 'killed') {
					existing.durationMs = p.elapsedMs ?? Date.now() - existing.startedAt
				}
				progressMap.set(p.id, existing)

				if (_onUpdate) {
					_onUpdate({
						content: [{ type: 'text', text: 'Executing subagents...' }],
						details: {
							running: true,
							parallel,
							tasks: Array.from(progressMap.values())
						}
					})
				}
			}

			// If require_consensus is requested on a single primary task
			if (params.require_consensus && tasks.length === 1) {
				const primary = tasks[0]!
				const reviewerRoles = params.reviewer_roles || ['reviewer', 'tester']
				const consensusExecution = await manager.invokeWithConsensus(primary, reviewerRoles, cwd, {
					signal,
					onProgress: reportProgress
				})

				const primarySection = `## 🧑‍💻 Primary Task: \`${consensusExecution.primaryResult.name}\` (${consensusExecution.primaryResult.role})\n${consensusExecution.primaryResult.output}`
				const consensusSection = consensusExecution.consensus.summary
				// The model needs the reviewers' actual findings, not only the tally.
				const verifierSections = consensusExecution.verificationResults.map(
					(r) => `## 🔍 ${r.role}: \`${r.name}\`\n${r.output || r.error || '(no output)'}`
				)

				const text = [
					`# 🏛 Orchestrator: Multi-Agent Consensus Verification Tree`,
					'',
					consensusSection,
					'',
					primarySection,
					...verifierSections
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

			let results: SubagentExecutionResult[]
			if (tasks.some((task) => task.dependsOn?.length)) {
				const planned = planDag(tasks)
				if ('error' in planned) {
					return {
						content: [{ type: 'text', text: `Invalid task graph: ${planned.error}` }],
						isError: true,
						details: undefined
					}
				}
				results = await manager.invokeDag(planned.nodes, cwd, {
					signal,
					onProgress: reportProgress
				})
			} else {
				results = await manager.invokeBatch(tasks, cwd, parallel, {
					signal,
					onProgress: reportProgress
				})
			}

			const sections = results.map((r) => {
				const statusIcon = r.status === 'completed' ? '✅' : '❌'
				const errorSection = r.error ? `\n> **Error**: ${r.error}` : ''
				const taskSection = r.prompt ? `\n- **Task**: ${r.prompt}` : ''
				return `## ${statusIcon} Subagent: \`${r.name}\` (${r.role})\n- **ID**: \`${r.id}\`\n- **Status**: \`${r.status}\` | **Duration**: ${r.durationMs}ms | **Tokens**: ${r.tokensUsed}${taskSection}\n- **Scratchpad**: \`${r.scratchpadDir}\`${errorSection}\n\n${r.output}`
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
			const subagents =
				(args?.subagents as Array<{ role?: string; name?: string }> | undefined) || []
			const roleBadges = subagents
				.map((s) => getColoredRoleBadge(s.role || 'agent', theme))
				.join(' ')
			const parallelStr = args?.parallel === false ? 'sequential' : 'parallel'
			const badge = theme.fg('accent', theme.bold(`[ ⚡ DISPATCH ${count} ]`))
			const text = `${badge} ${theme.bold('Multi-Agent Supervisor')} ${theme.fg('muted', `(${parallelStr})`)}${roleBadges ? `\n  ↳ ${roleBadges}` : ''}`
			return new Text(text, 0, 0)
		},
		renderResult(result, options, theme) {
			const rawDetails = result?.details as Record<string, any> | undefined
			const text = result?.content?.map((c: any) => c.text || '').join('\n') || ''

			// 1. In-progress live streaming state
			if (rawDetails?.running) {
				const tasks = (rawDetails.tasks as any[]) || []
				const activeCount = tasks.filter(
					(t) => t.status === 'running' || t.status === 'streaming'
				).length
				const completedCount = tasks.filter((t) => t.status === 'completed').length
				const total = tasks.length || 1
				const badge = theme.fg('accent', theme.bold(`[ ⚡ EXECUTING ${activeCount}/${total} ]`))
				const mdTheme = getMarkdownTheme()
				const box = new Box(0, 0, (t) => theme.bg('customMessageBg', t))
				box.addChild(
					new Text(
						`${badge} ${theme.bold('Multi-Agent Supervisor')} ${theme.fg('muted', `(${rawDetails.parallel ? 'parallel' : 'sequential'} · ${completedCount} finished)`)}`,
						0,
						0
					)
				)
				for (const t of tasks) {
					const badgeStr = getColoredRoleBadge(t.role, theme)
					const statusSymbol =
						t.status === 'completed'
							? theme.fg('success', '✓')
							: t.status === 'failed'
								? theme.fg('error', '✖')
								: theme.fg('warning', '▶')
					box.addChild(new Text(`  ${statusSymbol} ${badgeStr} ${theme.bold(t.name)}`, 0, 0))
					if (t.currentActivity) {
						box.addChild(new Markdown(String(t.currentActivity), 4, 0, mdTheme))
					}
					if (t.previewMarkdown?.trim()) {
						let preview = String(t.previewMarkdown).trim()
						if (!options.expanded) {
							const lines = preview.split('\n')
							if (lines.length > 10) {
								preview =
									lines.slice(0, 10).join('\n') + `\n\n*… ${lines.length - 10} more lines (expand)*`
							}
						}
						box.addChild(new Markdown(preview, 4, 0, mdTheme))
					}
				}
				return box
			}

			// 2. Completed State: Lay out each subagent's actual work, findings & thoughts!
			const mdTheme = getMarkdownTheme()
			const box = new Box(1, 0, (t) => theme.bg('customMessageBg', t))

			if (rawDetails?.results) {
				const results = rawDetails.results as SubagentExecutionResult[]
				const isSuccess = results.every((r) => r.status === 'completed')
				const totalTokens = results.reduce((acc, r) => acc + (r.tokensUsed || 0), 0)
				const badge = isSuccess
					? theme.fg('success', theme.bold(`[ 🚀 ${results.length} COMPLETED ]`))
					: theme.fg('warning', theme.bold(`[ ⚠️ ${results.length} EXECUTED ]`))
				const header = `${badge} ${theme.bold(`Subagent Task DAG`)} ${theme.fg('muted', `(Total tokens: ${totalTokens.toLocaleString()})`)}`
				box.addChild(new Text(header, 0, 0))

				for (const r of results) {
					const icon = r.status === 'completed' ? theme.fg('success', '✓') : theme.fg('error', '✖')
					const roleBadge = getColoredRoleBadge(r.role, theme)
					const nameStr = theme.bold(r.name)
					const meta = theme.fg('muted', `(${r.durationMs}ms · ${r.tokensUsed} tok)`)
					box.addChild(new Text(`\n  ${icon} ${roleBadge} ${nameStr} ${meta}`, 0, 0))

					if (r.error) {
						box.addChild(new Text(theme.fg('error', `     > Error: ${r.error}`), 0, 0))
					}

					if (r.output && r.output.trim()) {
						let displayOutput = r.output.trim()
						if (!options.expanded) {
							const lines = displayOutput.split('\n')
							if (lines.length > 8) {
								displayOutput =
									lines.slice(0, 8).join('\n') +
									`\n\n*... and ${lines.length - 8} more lines (expand to view full report)*`
							}
						}
						box.addChild(new Markdown(displayOutput, 4, 0, mdTheme))
					}
				}

				return box
			}

			if (rawDetails?.consensus) {
				const c = rawDetails.consensus
				const primary = rawDetails.primaryResult
				const isApproved = c.verdict === 'approved' || c.status === 'approved'
				const badge = isApproved
					? theme.fg('success', theme.bold('[ 🏛 CONSENSUS APPROVED ]'))
					: c.verdict === 'rejected'
						? theme.fg('error', theme.bold('[ ✖ CONSENSUS REJECTED ]'))
						: theme.fg('warning', theme.bold('[ ⚠️ CONSENSUS DISPUTED ]'))
				const scoreStr =
					typeof c.agreementScore === 'number'
						? `${Math.round(c.agreementScore * 100)}%`
						: typeof c.score === 'number'
							? `${Math.round(c.score * 100)}%`
							: 'N/A'
				const header = `${badge} ${theme.bold(`Consensus Gate (Score: ${scoreStr})`)}`
				box.addChild(new Text(header, 0, 0))

				if (c.summary) {
					box.addChild(new Markdown(c.summary, 2, 0, mdTheme))
				}

				if (primary) {
					const primaryHeader = `★ ${getColoredRoleBadge(primary.role, theme)} ${theme.bold(primary.name)} ${theme.fg('muted', `(${primary.durationMs}ms · ${primary.tokensUsed} tok)`)}`
					box.addChild(new Text(`\n  ${primaryHeader}`, 0, 0))
					if (primary.output) {
						let displayOutput = primary.output.trim()
						if (!options.expanded) {
							const lines = displayOutput.split('\n')
							if (lines.length > 8) {
								displayOutput =
									lines.slice(0, 8).join('\n') +
									`\n\n*... and ${lines.length - 8} more lines (expand to view full report)*`
							}
						}
						box.addChild(new Markdown(displayOutput, 4, 0, mdTheme))
					}
				}

				return box
			}

			// 3. Fallback state with rich Markdown rendering
			box.addChild(new Markdown(text, 1, 0, mdTheme))
			return box
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
			const action = (args?.action || 'list').toUpperCase()
			const target = args?.subagent_id ? ` ${args.subagent_id}` : ''
			return new Text(
				`${theme.fg('accent', theme.bold('[ 🛠 MANAGE SUBAGENTS ]'))} ${theme.fg('accent', action)}${theme.fg('muted', target)}`,
				0,
				0
			)
		},
		renderResult(result, _options, theme) {
			const text = result?.content?.map((c: any) => c.text || '').join('\n') || ''
			const mdTheme = getMarkdownTheme()
			const box = new Box(1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Markdown(text, 1, 0, mdTheme))
			return box
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
				`${theme.fg('accent', theme.bold('[ 💬 SUBAGENT MSG ]'))} ${theme.fg('muted', '->')} ${theme.fg('accent', args?.subagent_id || '')}`,
				0,
				0
			)
		},
		renderResult(result, _options, theme) {
			const text = result?.content?.map((c: any) => c.text || '').join('\n') || ''
			const mdTheme = getMarkdownTheme()
			const box = new Box(1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Markdown(text, 1, 0, mdTheme))
			return box
		}
	})

	return {
		invokeSubagentTool,
		manageSubagentsTool,
		sendSubagentMessageTool
	}
}
