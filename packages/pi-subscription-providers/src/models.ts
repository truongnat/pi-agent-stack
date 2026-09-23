import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import type { DiscoveredModel, Readiness } from './types.ts'

/** Subscription-backed model costs: non-zero opportunity costs for JEV routing. */
export function toProviderModels(
	provider: 'cursor' | 'antigravity',
	readiness: Readiness,
	limit = 24
): ProviderModelConfig[] {
	if (!readiness.ready) return []
	return readiness.models.slice(0, limit).map((model) => toModel(provider, model, readiness))
}

function toModel(
	provider: 'cursor' | 'antigravity',
	model: DiscoveredModel,
	readiness: Readiness
): ProviderModelConfig {
	return {
		id: model.id,
		name: `${model.name} (subscription)`,
		reasoning: model.reasoning,
		input: ['text'],
		cost: {
			input: readiness.marginalInputCost,
			output: readiness.marginalOutputCost,
			cacheRead: readiness.marginalInputCost * 0.1,
			cacheWrite: readiness.marginalInputCost * 0.25
		},
		contextWindow: provider === 'cursor' ? 200_000 : 200_000,
		maxTokens: 16_384
	}
}