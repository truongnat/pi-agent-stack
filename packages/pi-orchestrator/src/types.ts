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
	role: AgentRoleName
	prompt: string
	name?: string
	modelOverride?: string
	tools?: string[]
	isolateWorkspace?: boolean
	timeoutMs?: number
}

export type SubagentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'killed'

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

export interface SubagentProgressEvent {
	id: string
	role: AgentRoleName
	name: string
	status: 'running' | 'streaming' | 'completed' | 'failed' | 'killed'
	currentActivity?: string
	/** Streaming assistant markdown so the TUI can render it live. */
	previewMarkdown?: string
	tokensUsed?: number
	elapsedMs?: number
}
