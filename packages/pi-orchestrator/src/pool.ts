import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubagentTask } from './types.ts'

export type ModelCostTier = 'flash' | 'standard' | 'pro'

export interface AvailableModel {
	provider: string
	id: string
	fullModelName: string
	name?: string
	tier: ModelCostTier
	costScore: number // 1 = economical, 2 = balanced, 3 = premium
	reasoning: boolean
	contextWindow?: number
	ready: boolean
}

export interface ModelSelectionResult {
	fullModelName: string
	provider: string
	modelId: string
	tier: ModelCostTier
	rationale: string
}

/**
 * Classifies any model identifier into its capability and cost tier.
 */
export function classifyModelTier(modelId: string): {
	tier: ModelCostTier
	costScore: number
	reasoning: boolean
} {
	const lower = modelId.toLowerCase()
	const isReasoning = /thinking|reason|high|max|opus|o1|o3|r1/i.test(lower)

	// 1. Pro / Deep Reasoning / Frontier Tier
	if (
		/opus|o3|o1|r1|deepseek-reasoner|pro-high|3\.1-pro-high|claude-3-7-sonnet:high|claude-opus|grok-3/i.test(
			lower
		)
	) {
		return { tier: 'pro', costScore: 3, reasoning: isReasoning }
	}

	// 2. Flash / Fast & Economical Tier
	if (
		// `(^|[^a-z])mini`: gpt-5-mini and o4-mini are small, but every "gemini" contains "mini".
		/flash|haiku|(^|[^a-z])mini|spark|speed|light|small|nano|deepseek-chat/i.test(lower) &&
		!/pro-high/i.test(lower)
	) {
		return { tier: 'flash', costScore: 1, reasoning: isReasoning }
	}

	// 3. Standard / Code & Refactor Precision Tier (e.g. gpt-6-luna, claude-sonnet-4-6, gpt-4o)
	return { tier: 'standard', costScore: 2, reasoning: isReasoning }
}

/**
 * Discovers all authenticated, ready, and quota-available models across
 * subscription providers, OAuth accounts, models-store, and environment API keys.
 */
export function getAvailableModelPool(): AvailableModel[] {
	const pool: AvailableModel[] = []
	const seen = new Set<string>()

	const addModel = (
		provider: string,
		id: string,
		name?: string,
		contextWindow?: number,
		forcedTier?: ModelCostTier,
		forcedReasoning?: boolean
	) => {
		const fullModelName = id.includes('/') ? id : `${provider}/${id}`
		if (!seen.has(fullModelName)) {
			seen.add(fullModelName)
			const classified = classifyModelTier(id)
			pool.push({
				provider,
				id,
				fullModelName,
				name: name || id,
				tier: forcedTier || classified.tier,
				costScore: classified.costScore,
				reasoning: forcedReasoning !== undefined ? forcedReasoning : classified.reasoning,
				contextWindow,
				ready: true
			})
		}
	}

	// 1. Check ~/.pi/agent/models-store.json (Registered Pi Provider Models)
	try {
		const modelsStoreFile = join(homedir(), '.pi', 'agent', 'models-store.json')
		if (existsSync(modelsStoreFile)) {
			const store = JSON.parse(readFileSync(modelsStoreFile, 'utf8'))
			for (const [providerKey, data] of Object.entries(store)) {
				if (data && typeof data === 'object' && Array.isArray((data as any).models)) {
					for (const m of (data as any).models) {
						if (m.id) {
							addModel(
								m.provider || providerKey,
								m.id,
								m.name,
								m.contextWindow,
								undefined,
								m.reasoning
							)
						}
					}
				}
			}
		}
	} catch {
		// Ignore
	}

	// 2. Check ~/.pi/agent/subscription-providers-status.json (Antigravity, Cursor, Claude Code)
	try {
		const subStatusFile = join(homedir(), '.pi', 'agent', 'subscription-providers-status.json')
		if (existsSync(subStatusFile)) {
			const sub = JSON.parse(readFileSync(subStatusFile, 'utf8'))
			for (const [providerKey, info] of Object.entries(sub)) {
				if (
					info &&
					typeof info === 'object' &&
					(info as any).ready &&
					Array.isArray((info as any).models)
				) {
					const pName = (info as any).provider || providerKey
					for (const m of (info as any).models) {
						const modelId = m.id || m.name
						addModel(pName, modelId, m.name, 200000, undefined, Boolean(m.reasoning))
					}
				}
			}
		}
	} catch {
		// Ignore
	}

	// 3. Check ~/.pi/agent/auth.json for OAuth credentials
	try {
		const authFile = join(homedir(), '.pi', 'agent', 'auth.json')
		if (existsSync(authFile)) {
			const auth = JSON.parse(readFileSync(authFile, 'utf8'))
			if (auth['openai-codex']) {
				addModel('openai-codex', 'gpt-6-luna', 'GPT-6 Luna (OpenAI Codex)', 272000)
				addModel('openai-codex', 'gpt-6-astra', 'GPT-6 Astra', 272000)
				addModel('openai-codex', 'gpt-5.6-luna', 'GPT-5.6 Luna', 272000)
			}
			if (auth['anthropic']) {
				addModel('anthropic', 'claude-3-7-sonnet', 'Claude 3.7 Sonnet', 200000)
				addModel('anthropic', 'claude-3-5-haiku', 'Claude 3.5 Haiku', 200000)
			}
			if (auth['google'] || auth['gemini']) {
				addModel('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 1000000)
				addModel('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 2000000)
			}
		}
	} catch {
		// Ignore
	}

	// 4. Check Environment API keys for 2026 cutting-edge models
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
		addModel('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 1000000)
		addModel('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 2000000)
		addModel('gemini', 'gemini-2.0-flash', 'Gemini 2.0 Flash', 1000000)
	}
	if (process.env.OPENAI_API_KEY) {
		addModel('openai', 'gpt-4o-mini', 'GPT-4o Mini', 128000)
		addModel('openai', 'gpt-4o', 'GPT-4o', 128000)
		addModel('openai', 'o3-mini', 'OpenAI o3-mini (Reasoning)', 200000)
		addModel('openai', 'gpt-4.5-preview', 'GPT-4.5', 128000)
	}
	if (process.env.ANTHROPIC_API_KEY) {
		addModel('anthropic', 'claude-3-7-sonnet', 'Claude 3.7 Sonnet', 200000)
		addModel('anthropic', 'claude-3-5-haiku', 'Claude 3.5 Haiku', 200000)
	}
	if (process.env.DEEPSEEK_API_KEY) {
		addModel('deepseek', 'deepseek-chat', 'DeepSeek-V3', 64000)
		addModel('deepseek', 'deepseek-reasoner', 'DeepSeek-R1 (Reasoning)', 64000)
	}
	if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) {
		addModel('xai', 'grok-3', 'Grok 3', 131072)
		addModel('xai', 'grok-2', 'Grok 2', 131072)
	}
	if (process.env.MISTRAL_API_KEY) {
		addModel('mistral', 'codestral-2501', 'Codestral (Code Specialist)', 256000)
		addModel('mistral', 'mistral-large-2411', 'Mistral Large', 128000)
	}

	return pool
}

/**
 * Evaluates available models and selects the optimal model for the given task and role.
 * Enforces fitness bounds: prevents assigning overly expensive models to simple tasks,
 * and prevents assigning underpowered models to complex coding/refactoring tasks.
 */
export function selectOptimalModelForTask(
	task: SubagentTask,
	pool: AvailableModel[] = getAvailableModelPool(),
	dispatchedCounts: Record<string, number> = {}
): ModelSelectionResult {
	if (pool.length === 0) {
		return {
			fullModelName: 'default',
			provider: 'system',
			modelId: 'default',
			tier: 'standard',
			rationale: 'No external pool discovered; using system runner default.'
		}
	}

	const role = (task.role || 'researcher').toLowerCase()

	// 1. Explicit Model Override
	if (task.modelOverride && task.modelOverride.trim()) {
		const requested = task.modelOverride.trim().toLowerCase()
		// Exact name, then a whole word of the id ("sonnet", "pro"; not "mini" inside "gemini"),
		// then a tier name.
		const words = (id: string) => id.toLowerCase().split(/[-_.:/\s]+/)
		const exact =
			pool.find(
				(m) => m.fullModelName.toLowerCase() === requested || m.id.toLowerCase() === requested
			) ??
			pool.find((m) => words(m.id).includes(requested)) ??
			pool.find((m) => m.tier === requested)
		if (exact) {
			return {
				fullModelName: exact.fullModelName,
				provider: exact.provider,
				modelId: exact.id,
				tier: exact.tier,
				rationale: `Matched explicit override: "${task.modelOverride}".`
			}
		}
	}

	// 2. Determine Required Tier based on Role & Task complexity
	let targetTier: ModelCostTier = 'standard'
	if (role === 'researcher' || role === 'tester' || role === 'debugger') {
		// Fast, high-throughput, economical tier for scanning files and running commands
		targetTier = 'flash'
	} else if (role === 'coder') {
		// High precision, code generation and refactoring tier
		targetTier = 'standard'
	} else if (role === 'reviewer' || role === 'architect' || role === 'security-auditor') {
		// Deep verification, reasoning, and critique tier
		targetTier = 'pro'
	}

	// If prompt explicitly mentions deep reasoning or complex architecture, upgrade tier
	if (
		targetTier === 'flash' &&
		/complex architecture|root-cause deep|security vulnerability|concurrency deadlock/i.test(
			task.prompt
		)
	) {
		targetTier = 'standard'
	}

	// 3. Filter candidate models by target tier
	let candidates = pool.filter((m) => m.tier === targetTier)

	// If no candidate matches target tier, fallback to adjacent tier
	if (candidates.length === 0) {
		if (targetTier === 'pro') {
			candidates = pool.filter((m) => m.tier === 'standard')
		} else if (targetTier === 'flash') {
			candidates = pool.filter((m) => m.tier === 'standard')
		}
	}
	if (candidates.length === 0) {
		candidates = pool
	}

	// 4. Multi-Provider Load Balancing
	// Pick the candidate from the provider with the lowest current load in this batch
	candidates.sort((a, b) => {
		const loadA = dispatchedCounts[a.provider] || 0
		const loadB = dispatchedCounts[b.provider] || 0
		if (loadA !== loadB) return loadA - loadB
		return a.costScore - b.costScore
	})

	const selected = candidates[0]!
	return {
		fullModelName: selected.fullModelName,
		provider: selected.provider,
		modelId: selected.id,
		tier: selected.tier,
		rationale: `Selected ${selected.tier} tier model (${selected.fullModelName}) for [${role}] based on task fitness and provider load.`
	}
}
