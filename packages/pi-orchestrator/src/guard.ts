import type { OrchestratorConfig } from './config.ts'
import { getAvailableModelPool } from './pool.ts'

/**
 * Providers the worker pool can actually dispatch to. Counting env keys, a Jev key or a Claude
 * CLI credential file let the diversity guard pass with no usable second provider.
 */
export function getAvailableProviders(): string[] {
	return [...new Set(getAvailableModelPool().map((m) => m.provider.toLowerCase()))].sort()
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
