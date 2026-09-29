import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod/v4'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { SubagentManager } from './manager.ts'
import { createOrchestratorTools, executeInvokeSubagent } from './tools.ts'

const taskSchema = z.object({
	id: z.string().optional(),
	depends_on: z.array(z.string()).optional(),
	role: z.string().min(1),
	prompt: z.string().min(1),
	scope: z.array(z.string().trim().min(1)).min(1),
	name: z.string().optional(),
	model_override: z.string().optional(),
	tools: z.array(z.string()).optional(),
	isolate_workspace: z.boolean().optional(),
	timeout_ms: z.number().positive().optional()
})

const invokeSchema = {
	subagents: z.array(taskSchema).min(1),
	parallel: z.boolean().optional(),
	require_consensus: z.boolean().optional(),
	reviewer_roles: z.array(z.string()).optional()
}

const manageSchema = {
	action: z.enum(['list', 'status', 'batch_status', 'cancel_batch', 'kill', 'kill_all', 'clear']),
	subagent_id: z.string().optional(),
	batch_id: z.string().optional()
}

const sendSchema = { subagent_id: z.string().min(1), message: z.string().min(1) }

function asMcpResult(result: {
	content: Array<{ type: string; text?: string }>
	isError?: boolean
}) {
	return {
		content: result.content.flatMap((item) =>
			item.type === 'text' && item.text ? [{ type: 'text' as const, text: item.text }] : []
		),
		...(result.isError ? { isError: true } : {})
	}
}

export function createOrchestratorMcpServer(
	manager: SubagentManager,
	cwd: string,
	dashboardSessionId = ''
): McpServer {
	const tools = createOrchestratorTools(manager, () => dashboardSessionId)
	const server = new McpServer({ name: 'pi-orchestrator', version: '0.1.0' })

	server.registerTool(
		'invoke_subagent',
		{
			description: tools.invokeSubagentTool.description,
			inputSchema: invokeSchema
		},
		async (params) =>
			asMcpResult(await executeInvokeSubagent(manager, params, cwd, () => dashboardSessionId))
	)
	server.registerTool(
		'manage_subagents',
		{
			description: tools.manageSubagentsTool.description,
			inputSchema: manageSchema
		},
		async (params) =>
			asMcpResult(
				await tools.manageSubagentsTool.execute(
					randomUUID(),
					params as Parameters<typeof tools.manageSubagentsTool.execute>[1],
					undefined,
					undefined,
					{ cwd } as unknown as ExtensionContext
				)
			)
	)
	server.registerTool(
		'send_subagent_message',
		{
			description: tools.sendSubagentMessageTool.description,
			inputSchema: sendSchema
		},
		async (params) =>
			asMcpResult(
				await tools.sendSubagentMessageTool.execute(
					randomUUID(),
					params as Parameters<typeof tools.sendSubagentMessageTool.execute>[1],
					undefined,
					undefined,
					{ cwd } as unknown as ExtensionContext
				)
			)
	)
	return server
}

async function main(): Promise<void> {
	const cwd = process.env.PI_ORCHESTRATOR_MCP_CWD
	if (!cwd) throw new Error('PI_ORCHESTRATOR_MCP_CWD is required')
	const manager = new SubagentManager()
	const server = createOrchestratorMcpServer(
		manager,
		cwd,
		process.env.PI_ORCHESTRATOR_MCP_SESSION ?? ''
	)
	const shutdown = () => {
		manager.killAll()
		void server.close()
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
	process.stdin.on('end', shutdown)
	await server.connect(new StdioServerTransport())
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	void main().catch((error: unknown) => {
		process.stderr.write(
			`pi-orchestrator MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`
		)
		process.exitCode = 1
	})
}
