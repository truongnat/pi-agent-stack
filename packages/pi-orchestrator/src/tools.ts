import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { renderMarkdown } from './tui-markdown.ts'
import * as t from 'typebox'
import { planDag, type DagNode } from './dag.ts'
import { checkOrchestratorGuard } from './guard.ts'
import { SubagentManager } from './manager.ts'
import {
	findTaskScopeConflicts,
	type SubagentExecutionResult,
	type SubagentProgressEvent,
	type SubagentTask
} from './types.ts'
import { publishDashboardAgentUpdate } from './dashboard.ts'

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
			'Role of the subagent: "researcher" (codebase search & analysis), "coder" (edits, then self-test with bash), "tester" (independent second-pass tests), "reviewer" (code diff critique), or a custom role.'
	}),
	prompt: t.String({
		description: 'Detailed and actionable instruction for what this subagent should accomplish.'
	}),
	scope: t.Array(t.String({ minLength: 1 }), {
		description:
			'Required unique work-unit keys (target plus concern, e.g. "screen:ac12001/frontend-naming"). Do not assign one key to multiple agents.'
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
			description:
				'Optional subset of the role allowlist (defaults to the full role list). Names outside the allowlist are rejected, not dropped.'
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
		t.Literal('batch_status', { description: 'Get batch progress and completed task outputs.' }),
		t.Literal('cancel_batch', { description: 'Cancel a running batch and stop its workers.' }),
		t.Literal('kill', { description: 'Kill a running subagent.' }),
		t.Literal('kill_all', { description: 'Kill all running subagents.' }),
		t.Literal('clear', { description: 'Clear history of completed/failed subagents.' })
	]),
	subagent_id: t.Optional(
		t.String({
			description: 'Subagent ID (required for "status" or "kill" action).'
		})
	),
	batch_id: t.Optional(t.String({ description: 'Batch ID returned by invoke_subagent.' }))
})

const SendSubagentMessageSchema = t.Object({
	subagent_id: t.String({
		description: 'Target subagent ID.'
	}),
	message: t.String({
		description: 'Guidance message to send to the subagent.'
	})
})

type InvokeSubagentParams = Parameters<ToolDefinition<typeof InvokeSubagentSchema>['execute']>[1]

export async function executeInvokeSubagent(
	manager: SubagentManager,
	params: InvokeSubagentParams,
	cwd: string,
	getDashboardSessionId: () => string = () => ''
) {
	const guardCheck = checkOrchestratorGuard(manager.config)
	if (!guardCheck.allowed) {
		return {
			content: [
				{
					type: 'text' as const,
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
	if (!params.subagents.length) {
		return {
			content: [{ type: 'text' as const, text: 'No subagent tasks provided.' }],
			isError: true,
			details: undefined
		}
	}

	const tasks: SubagentTask[] = params.subagents.map((task) => ({
		...(task.id ? { id: task.id } : {}),
		...(task.depends_on ? { dependsOn: task.depends_on } : {}),
		role: task.role,
		prompt: task.prompt,
		scope: task.scope,
		name: task.name,
		modelOverride: task.model_override,
		tools: task.tools,
		...(task.isolate_workspace !== undefined ? { isolateWorkspace: task.isolate_workspace } : {}),
		...(task.timeout_ms ? { timeoutMs: task.timeout_ms } : {})
	}))
	const parallel = params.parallel ?? true
	const scopeConflicts = findTaskScopeConflicts(tasks)
	if (scopeConflicts.length) {
		const conflictText = scopeConflicts
			.map((conflict) => `- \`${conflict.scope}\`: ${conflict.taskIds.join(', ')}`)
			.join('\n')
		return {
			content: [
				{
					type: 'text' as const,
					text: `Cannot dispatch tasks with overlapping scope:\n${conflictText}\nSplit the responsibilities or assign distinct target/concern keys.`
				}
			],
			isError: true,
			details: { scopeConflicts }
		}
	}

	let dagNodes: DagNode[] | undefined
	if (tasks.some((task) => task.dependsOn?.length)) {
		const planned = planDag(tasks)
		if ('error' in planned) {
			return {
				content: [{ type: 'text' as const, text: `Invalid task graph: ${planned.error}` }],
				isError: true,
				details: undefined
			}
		}
		dagNodes = planned.nodes
	}

	const progressMap = new Map<
		string,
		{
			role: string
			name: string
			model?: string
			status: string
			currentActivity?: string
			previewMarkdown?: string
			startedAt: number
			durationMs?: number
		}
	>()
	const reportProgress = (event: SubagentProgressEvent) => {
		const existing = progressMap.get(event.id) || {
			role: event.role,
			name: event.name,
			model: event.model,
			status: event.status,
			currentActivity: event.currentActivity,
			previewMarkdown: event.previewMarkdown,
			startedAt: Date.now()
		}
		existing.model = event.model ?? existing.model
		existing.status = event.status
		if (event.currentActivity) existing.currentActivity = event.currentActivity
		if (event.previewMarkdown !== undefined) existing.previewMarkdown = event.previewMarkdown
		if (event.status === 'completed' || event.status === 'failed' || event.status === 'killed') {
			existing.durationMs = event.elapsedMs ?? Date.now() - existing.startedAt
		}
		progressMap.set(event.id, existing)
		publishDashboardAgentUpdate(
			getDashboardSessionId(),
			Array.from(progressMap, ([id, task]) => ({ id, ...task })),
			manager.lastDag.nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id })))
		)
	}

	const batch = manager.startBatch(async (signal, onProgress) => {
		if (params.require_consensus && tasks.length === 1) {
			const execution = await manager.invokeWithConsensus(
				tasks[0]!,
				params.reviewer_roles || ['reviewer', 'tester'],
				cwd,
				{ signal, onProgress }
			)
			return [
				{
					...execution.primaryResult,
					output: `${execution.consensus.summary}\n\n${execution.primaryResult.output}`
				},
				...execution.verificationResults
			]
		}
		if (dagNodes) return manager.invokeDag(dagNodes, cwd, { signal, onProgress })
		return manager.invokeBatch(tasks, cwd, parallel, { signal, onProgress })
	}, reportProgress)

	const text = [
		`# 🤖 Started subagent batch \`${batch.id}\` (${tasks.length} task(s), ${parallel ? 'Parallel' : 'Sequential'})`,
		'',
		...batch.subagentIds.map((id) => `- \`${id}\``),
		'Use manage_subagents with action "batch_status" to inspect results; actions remain available while workers run.'
	].join('\n')
	return {
		content: [{ type: 'text' as const, text }],
		details: { batchId: batch.id, status: batch.status, subagentIds: batch.subagentIds }
	}
}

export function createOrchestratorTools(
	manager: SubagentManager,
	getDashboardSessionId: () => string = () => ''
) {
	const invokeSubagentTool: ToolDefinition<typeof InvokeSubagentSchema> = defineTool({
		name: 'invoke_subagent',
		label: 'Invoke Subagents',
		description:
			'Spawn specialized subagents with private scratchpads and role-scoped tools. Give every task unique scope keys; split overlapping responsibilities before dispatch.',
		promptSnippet:
			'invoke_subagent({ subagents: [{ role: "researcher", prompt: "...", scope: ["screen:ac12001/frontend-naming"] }], parallel: true }) — start a manageable batch',
		parameters: InvokeSubagentSchema,
		executionMode: 'sequential',
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeInvokeSubagent(manager, params, ctx.cwd || process.cwd(), getDashboardSessionId)
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
						box.addChild(new Text(theme.fg('muted', String(t.currentActivity)), 4, 0))
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
						box.addChild(renderMarkdown(preview, 4, theme))
					}
				}
				return box
			}

			// 2. Completed State: Lay out each subagent's actual work, findings & thoughts!
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
						box.addChild(renderMarkdown(displayOutput, 4, theme))
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
					box.addChild(renderMarkdown(c.summary, 2, theme))
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
						box.addChild(renderMarkdown(displayOutput, 4, theme))
					}
				}

				return box
			}

			// 3. Fallback state with rich Markdown rendering
			box.addChild(renderMarkdown(text, 1, theme))
			return box
		}
	})

	const manageSubagentsTool: ToolDefinition<typeof ManageSubagentsSchema, any> = defineTool({
		name: 'manage_subagents',
		label: 'Manage Subagents',
		description: 'List, inspect, steer, cancel, or kill managed subagent batches and workers.',
		promptSnippet:
			'manage_subagents({ action: "list" | "batch_status" | "cancel_batch" | "status" | "kill", batch_id, subagent_id })',
		parameters: ManageSubagentsSchema,
		executionMode: 'sequential',
		async execute(_toolCallId, params): Promise<any> {
			switch (params.action) {
				case 'list': {
					const list = manager.listSubagents()
					const batches = manager.listBatches()
					if (list.length === 0 && batches.length === 0) {
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
					const batchRows = batches.map(
						(batch) =>
							`- \`${batch.id}\` — **${batch.status}** (${batch.subagentIds.length} worker(s))`
					)
					return {
						content: [
							{
								type: 'text',
								text: `### 📋 Managed Subagents (Total: ${list.length})\n\n${list.length ? table : 'No subagents yet.'}\n\n### Batches\n${batchRows.length ? batchRows.join('\n') : 'No batches yet.'}`
							}
						],
						details: { count: list.length, subagents: list, batches }
					}
				}

				case 'batch_status': {
					if (!params.batch_id) {
						return {
							content: [{ type: 'text', text: 'Error: batch_id is required for batch_status.' }],
							isError: true,
							details: undefined
						}
					}
					const batch = manager.getBatch(params.batch_id)
					if (!batch) {
						return {
							content: [{ type: 'text', text: `Batch not found: "${params.batch_id}".` }],
							isError: true,
							details: undefined
						}
					}
					const tasks = batch.subagentIds.map((id) => {
						const subagent = manager.getSubagent(id)
						return `- \`${id}\`: ${subagent?.status ?? 'unknown'} — ${subagent?.name ?? ''}`
					})
					const outputs = batch.results.map(
						(result) =>
							`## ${result.name} (${result.status})\n${result.error ? `Error: ${result.error}\n` : ''}${result.output || '(no output)'}`
					)
					return {
						content: [
							{
								type: 'text',
								text: [`### Batch ${batch.id}: ${batch.status}`, ...tasks, ...outputs].join('\n\n')
							}
						],
						details: batch
					}
				}

				case 'cancel_batch': {
					if (!params.batch_id) {
						return {
							content: [{ type: 'text', text: 'Error: batch_id is required for cancel_batch.' }],
							isError: true,
							details: undefined
						}
					}
					const cancelled = manager.cancelBatch(params.batch_id)
					return {
						content: [
							{
								type: 'text',
								text: cancelled
									? `Cancelled batch "${params.batch_id}".`
									: `Batch "${params.batch_id}" was not running or does not exist.`
							}
						],
						details: { cancelled }
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
			const box = new Box(1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(renderMarkdown(text, 1, theme))
			return box
		}
	})

	const sendSubagentMessageTool: ToolDefinition<typeof SendSubagentMessageSchema> = defineTool({
		name: 'send_subagent_message',
		label: 'Send Subagent Message',
		description:
			'Steer a running subagent: the message reaches it after its current tool calls, before its next model call.',
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

			// Only a pi worker in RPC mode can take a message; CLI fallbacks and finished runs cannot.
			const delivered =
				sub.status === 'running' && sub.send?.({ type: 'steer', message: params.message })
			if (!delivered) {
				return {
					content: [
						{
							type: 'text',
							text: `Subagent "${sub.name}" is not running a pi worker (status: ${sub.status}); the message was not delivered.`
						}
					],
					isError: true,
					details: undefined
				}
			}
			return {
				content: [
					{
						type: 'text',
						text: `Sent to "${sub.name}" as a steer: it arrives after the worker's current tool calls, before its next model call.`
					}
				],
				details: { delivered: true, subagentId: sub.id }
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
			const box = new Box(1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(renderMarkdown(text, 1, theme))
			return box
		}
	})

	return {
		invokeSubagentTool,
		manageSubagentsTool,
		sendSubagentMessageTool
	}
}
