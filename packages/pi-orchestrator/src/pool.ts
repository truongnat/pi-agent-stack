import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubagentTask } from './types.ts'

export type ModelCostTier = 'flash' | 'standard' | 'pro'

export interface AvailableModel {
	provider: string
	id: string
	fullModelName: string
	tier: ModelCostTier
	costScore: number // 1 = economical, 2 = balanced, 3 = premium
	reasoning: boolean
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
 * Discovers all authenticated, ready, and quota-available models across
 * subscription providers, OAuth accounts, and environment API keys.
 */
export function getAvailableModelPool(): AvailableModel[] {
	const pool: AvailableModel[] = []
	const seen = new Set<string>()

	const addModel = (
		provider: string,
		id: string,
		tier: ModelCostTier,
		costScore: number,
		reasoning = false
	) => {
		const fullModelName = id.includes('/') ? id : `${provider}/${id}`
		if (!seen.has(fullModelName)) {
			seen.add(fullModelName)
			pool.push({
				provider,
				id,
				fullModelName,
				tier,
				costScore,
				reasoning,
				ready: true
			})
		}
	}

	// 1. Check ~/.pi/agent/subscription-providers-status.json
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
						const isReasoning = Boolean(m.reasoning)
						let tier: ModelCostTier = 'standard'
						let cost = 2

						if (/flash|mini|haiku|speed|small|light/i.test(modelId)) {
							tier = 'flash'
							cost = 1
						} else if (/pro|opus|o1|o3|heavy|high|max/i.test(modelId)) {
							tier = 'pro'
							cost = 3
						}

						addModel(pName, modelId, tier, cost, isReasoning)
					}
				}
			}
		}
	} catch {
		// Ignore parse errors
	}

	// 2. Check ~/.pi/agent/auth.json for OAuth providers (e.g. openai-codex)
	try {
		const authFile = join(homedir(), '.pi', 'agent', 'auth.json')
		if (existsSync(authFile)) {
			const auth = JSON.parse(readFileSync(authFile, 'utf8'))
			if (auth['openai-codex']) {
				addModel('openai-codex', 'gpt-6-luna', 'standard', 2, false)
			}
			if (auth['anthropic']) {
				addModel('anthropic', 'claude-3-7-sonnet', 'standard', 2, true)
				addModel('anthropic', 'claude-3-5-haiku', 'flash', 1, false)
			}
			if (auth['google'] || auth['gemini']) {
				addModel('gemini', 'gemini-2.5-flash', 'flash', 1, false)
				addModel('gemini', 'gemini-2.5-pro', 'pro', 3, true)
			}
		}
	} catch {
		// Ignore
	}

	// 3. Check ~/.pi/agent/settings.json default provider/model
	try {
		const settingsFile = join(homedir(), '.pi', 'agent', 'settings.json')
		if (existsSync(settingsFile)) {
			const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
			if (settings.defaultProvider && settings.defaultModel) {
				addModel(settings.defaultProvider, settings.defaultModel, 'standard', 2, false)
			}
		}
	} catch {
		// Ignore
	}

	// 4. Check Environment API keys
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
		addModel('gemini', 'gemini-2.5-flash', 'flash', 1, false)
		addModel('gemini', 'gemini-2.5-pro', 'pro', 3, true)
	}
	if (process.env.OPENAI_API_KEY) {
		addModel('openai', 'gpt-4o-mini', 'flash', 1, false)
		addModel('openai', 'gpt-4o', 'standard', 2, false)
		addModel('openai', 'o3-mini', 'pro', 3, true)
	}
	if (process.env.ANTHROPIC_API_KEY) {
		addModel('anthropic', 'claude-3-5-haiku', 'flash', 1, false)
		addModel('anthropic', 'claude-3-7-sonnet', 'standard', 2, true)
	}
	if (process.env.DEEPSEEK_API_KEY) {
		addModel('deepseek', 'deepseek-chat', 'flash', 1, false)
		addModel('deepseek', 'deepseek-reasoner', 'pro', 3, true)
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
	// If no models discovered in the dynamic pool, fallback to safe default
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
		// Exact match in pool
		const exact = pool.find(
			(m) =>
				m.fullModelName.toLowerCase() === requested ||
				m.id.toLowerCase() === requested ||
				m.id.toLowerCase().includes(requested)
		)
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
