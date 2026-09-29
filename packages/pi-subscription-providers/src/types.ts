/** Shared types for subscription-backed CLI providers. */

export type BillingMode = 'api' | 'subscription' | 'unknown'

export type ProviderId = 'cursor' | 'antigravity' | 'claude-code' | 'opencode'

export type ProviderConfig = {
	enabled: boolean
	/** Absolute path, bare command name, or "auto". */
	command: string
	timeoutMs: number
	maxOutputChars: number
	/** Bounded readiness/model-discovery cache TTL. */
	readinessTtlMs: number
	/** Soft latency estimate used by JEV when no probe sample exists (ms). */
	latencyEstimateMs: number
	/**
	 * Opportunity-cost rates ($/MTok) for subscription usage.
	 * Never claim zero; these are marginal estimates for routing, not invoices.
	 */
	marginalInputCost: number
	marginalOutputCost: number
}

export type RootConfig = {
	cursor: ProviderConfig
	antigravity: ProviderConfig
	'claude-code': ProviderConfig
	opencode: ProviderConfig
}

export type DiscoveredModel = {
	id: string
	name: string
	reasoning: boolean
	contextWindow?: number | undefined
	maxTokens?: number | undefined
}

export type Readiness = {
	provider: ProviderId
	ready: boolean
	/** Non-secret diagnostic (never emails, tokens, or raw CLI dumps). */
	reason: string
	command?: string
	billingMode: BillingMode
	quotaAvailable?: boolean | undefined
	latencyEstimateMs: number
	marginalInputCost: number
	marginalOutputCost: number
	models: DiscoveredModel[]
	checkedAt: number
	/** Documented tool semantics for this provider. */
	toolMode: 'compatibility'
}

export type StatusSnapshot = {
	updatedAt: number
	cursor: Readiness
	antigravity: Readiness
	/** Absent in status files written before Claude Code support. */
	'claude-code'?: Readiness
	/** Absent in status files written before OpenCode support. */
	opencode?: Readiness
}

export type RunResult = {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
	aborted: boolean
	durationMs: number
}

export type Runner = (request: {
	command: string
	args: string[]
	cwd?: string
	timeoutMs: number
	maxOutputChars: number
	signal?: AbortSignal
	env?: NodeJS.ProcessEnv
	stdin?: string
}) => Promise<RunResult>
