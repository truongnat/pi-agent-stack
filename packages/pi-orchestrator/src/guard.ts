import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrchestratorConfig } from './config.ts'

/**
 * Inspect active environment variables, auth tokens, and subscription status
 * to discover all ready and available LLM providers.
 */
export function getAvailableProviders(): string[] {
	const providers = new Set<string>()

	// 1. Check process.env API keys
	if (process.env.ANTHROPIC_API_KEY) providers.add('anthropic')
	if (process.env.OPENAI_API_KEY) providers.add('openai')
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) providers.add('gemini')
	if (process.env.DEEPSEEK_API_KEY) providers.add('deepseek')
	if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) providers.add('grok')
	if (process.env.OPENROUTER_API_KEY) providers.add('openrouter')
	if (process.env.MISTRAL_API_KEY) providers.add('mistral')
	if (process.env.COHERE_API_KEY) providers.add('cohere')
	if (process.env.JEV_API_KEY) providers.add('typesafe')

	// 2. Check ~/.pi/agent/auth.json
	try {
		const authFile = join(homedir(), '.pi', 'agent', 'auth.json')
		if (existsSync(authFile)) {
			const auth = JSON.parse(readFileSync(authFile, 'utf8'))
			for (const key of Object.keys(auth)) {
				if (auth[key] && typeof auth[key] === 'object') {
					providers.add(key.toLowerCase())
				}
			}
		}
	} catch {
		// Ignore parse errors
	}

	// 3. Check ~/.pi/agent/subscription-providers-status.json
	try {
		const subStatusFile = join(homedir(), '.pi', 'agent', 'subscription-providers-status.json')
		if (existsSync(subStatusFile)) {
			const sub = JSON.parse(readFileSync(subStatusFile, 'utf8'))
			if (Array.isArray(sub.providers)) {
				for (const p of sub.providers) {
					if (p.ready && p.provider) {
						providers.add(p.provider.toLowerCase())
					}
				}
			}
		}
	} catch {
		// Ignore parse errors
	}

	// 4. Check Claude CLI OAuth credentials
	try {
		const claudeCreds = join(homedir(), '.claude', '.credentials.json')
		if (existsSync(claudeCreds)) {
			providers.add('claude-code')
		}
	} catch {
		// Ignore
	}

	return Array.from(providers).sort()
}

export interface GuardCheckResult {
	allowed: boolean
	reason?: string
	providers: string[]
}

/**
 * Validate that the orchestrator is enabled and meets the minimum provider threshold.
 */
export function checkOrchestratorGuard(
	config: OrchestratorConfig,
	explicitProviders?: string[]
): GuardCheckResult {
	const providers = explicitProviders ?? getAvailableProviders()

	if (!config.enabled) {
		return {
			allowed: false,
			reason: 'Multi-Agent Orchestrator is disabled via config (enabled: false).',
			providers
		}
	}

	if (config.guard && providers.length < config.minProvidersRequired) {
		const found = providers.length > 0 ? providers.join(', ') : 'none'
		return {
			allowed: false,
			reason: `Orchestrator Guard: Multi-agent execution requires at least ${config.minProvidersRequired} available/configured providers (found ${providers.length}: [${found}]). Multi-agent supervisor requires provider diversity to prevent single-provider rate-limiting or quota exhaustion. Please configure additional providers in ~/.pi/agent/auth.json or subscription-providers.json.`,
			providers
		}
	}

	return {
		allowed: true,
		providers
	}
}
