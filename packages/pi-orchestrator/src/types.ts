export type AgentRoleName = 'researcher' | 'coder' | 'tester' | 'reviewer' | string

export type ModelTier = 'flash' | 'sonnet' | 'mini' | 'pro' | 'cursor' | 'local' | string

export interface AgentRoleDefinition {
	name: AgentRoleName
	label: string
	description: string
	defaultModelTier: ModelTier
	allowedTools: string[]
	systemPrompt: string
}

export interface SubagentTask {
	/** Graph id other tasks can name in dependsOn (auto `t1`, `t2`, … when missing). */
	id?: string
	/** Ids of tasks that must complete first; their outputs are appended to this prompt. */
	dependsOn?: string[]
	role: AgentRoleName
	prompt: string
	/** Stable target/concern keys; duplicate keys in one batch are rejected before dispatch. */
	scope?: string[]
	name?: string
	modelOverride?: string
	tools?: string[]
	isolateWorkspace?: boolean
	timeoutMs?: number
}

export function findTaskScopeConflicts(
	tasks: SubagentTask[]
): Array<{ scope: string; taskIds: string[] }> {
	const owners = new Map<string, Set<string>>()
	for (const [index, task] of tasks.entries()) {
		const taskId = task.id ?? `t${index + 1}`
		for (const value of task.scope ?? []) {
			const scope = value.trim().toLocaleLowerCase('en-US')
			if (!scope) continue
			const taskIds = owners.get(scope) ?? new Set<string>()
			taskIds.add(taskId)
			owners.set(scope, taskIds)
		}
	}
	return Array.from(owners, ([scope, taskIds]) => ({ scope, taskIds: [...taskIds] })).filter(
		(conflict) => conflict.taskIds.length > 1
	)
}

export type SubagentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'killed' | 'skipped'

export interface SubagentLogEntry {
	timestamp: number
	type: 'info' | 'tool' | 'error' | 'thought'
	message: string
}

export interface SubagentInstance {
	id: string
	role: AgentRoleName
	name: string
	status: SubagentStatus
	prompt: string
	model: string
	startedAt: number
	completedAt?: number
	pid?: number
	output?: string
	error?: string
	tokensUsed: number
	scratchpadDir: string
	logs: SubagentLogEntry[]
	/** Writes an RPC command to the running pi worker; undefined once it settled or exited. */
	send?: ((command: object) => boolean) | undefined
	/** Set when the task ran in an isolated worktree. */
	patch?: { patchPath: string; files: string[] }
}

export interface SubagentExecutionResult {
	id: string
	role: AgentRoleName
	name: string
	prompt?: string
	status: SubagentStatus
	output: string
	error?: string
	tokensUsed: number
	durationMs: number
	scratchpadDir: string
}

export type SubagentBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface SubagentBatchRun {
	id: string
	status: SubagentBatchStatus
	startedAt: number
	completedAt?: number
	subagentIds: string[]
	results: SubagentExecutionResult[]
	error?: string
}

export interface SubagentProgressEvent {
	id: string
	role: AgentRoleName
	name: string
	model?: string
	status: 'running' | 'streaming' | 'completed' | 'failed' | 'killed'
	currentActivity?: string
	/** Streaming assistant markdown so the TUI can render it live. */
	previewMarkdown?: string
	tokensUsed?: number
	elapsedMs?: number
}
