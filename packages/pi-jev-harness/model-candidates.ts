/**
 * Build the ranked model candidate list for a routing turn.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { RoutingModel } from './jev.ts'
import {
	freshSubscriptionProviders,
	readSubscriptionStatus,
	type SubscriptionReadiness
} from './subscription.ts'
import type { Harness } from './types.ts'

function modelCost(model: { cost: { input: number; output: number } }): number {
	return model.cost.input + model.cost.output
}

export function toRoutingModel(
	model: {
		provider: string
		id: string
		name: string
		cost: { input: number; output: number }
		contextWindow: number
	},
	extra: Partial<RoutingModel> = {}
): RoutingModel {
	const billingMode = extra.billingMode ?? 'api'
	const latencyEstimateMs =
		extra.latencyEstimateMs ?? (billingMode === 'subscription' ? 8_000 : 1_500)
	const marginalInputCost = extra.marginalInputCost ?? model.cost.input
	const marginalOutputCost = extra.marginalOutputCost ?? model.cost.output
	const toolMode = extra.toolMode ?? 'native'
	const readiness = extra.readiness ?? true
	const quota = extra.quotaAvailable
	const bits = [
		model.name,
		model.provider,
		`billing=${billingMode}`,
		`ready=${readiness}`,
		quota === undefined ? null : `quota=${quota}`,
		`latency~${latencyEstimateMs}ms`,
		`marginal=$${marginalInputCost}/$${marginalOutputCost} per MTok`,
		`tools=${toolMode}`,
		`list=$${model.cost.input}/M in, $${model.cost.output}/M out`
	].filter((bit): bit is string => bit !== null)
	return {
		key: `${model.provider}/${model.id}`,
		provider: model.provider,
		label: bits.join('; '),
		inputCost: model.cost.input,
		outputCost: model.cost.output,
		contextWindow: model.contextWindow,
		billingMode,
		readiness,
		...(quota === undefined ? {} : { quotaAvailable: quota }),
		latencyEstimateMs,
		marginalInputCost,
		marginalOutputCost,
		toolMode
	}
}

type CatalogModel = {
	provider: string
	id: string
	name: string
	input: readonly string[]
	cost: { input: number; output: number }
	contextWindow: number
}

function sameFamilyModels(
	available: CatalogModel[],
	current: CatalogModel,
	minimumContext: number
): RoutingModel[] {
	return available
		.filter(
			(model) =>
				model.provider === current.provider &&
				model.input.includes('text') &&
				model.contextWindow >= minimumContext &&
				(model.id === current.id || /^gpt-5\.6-(luna|terra|sol)$/.test(model.id))
		)
		.map((model) => toRoutingModel(model, { billingMode: 'api', toolMode: 'native' }))
}

function xaiModels(available: CatalogModel[], minimumContext: number): RoutingModel[] {
	return available
		.filter(
			(model) =>
				model.provider === 'xai' &&
				model.input.includes('text') &&
				model.contextWindow >= minimumContext
		)
		.sort((left, right) => modelCost(left) - modelCost(right))
		.slice(0, 3)
		.map((model) => toRoutingModel(model, { billingMode: 'api', toolMode: 'native' }))
}

function subscriptionFromCache(row: SubscriptionReadiness, minimumContext: number): RoutingModel[] {
	return row.models.slice(0, 3).map((cached) =>
		toRoutingModel(
			{
				provider: row.provider,
				id: cached.id,
				name: cached.name,
				cost: { input: row.marginalInputCost, output: row.marginalOutputCost },
				contextWindow: Math.max(minimumContext, 100_000)
			},
			{
				billingMode: 'subscription',
				readiness: true,
				quotaAvailable: row.quotaAvailable,
				latencyEstimateMs: row.latencyEstimateMs,
				marginalInputCost: row.marginalInputCost,
				marginalOutputCost: row.marginalOutputCost,
				toolMode: 'compatibility'
			}
		)
	)
}

function subscriptionFromRegistry(
	row: SubscriptionReadiness,
	available: CatalogModel[],
	minimumContext: number
): RoutingModel[] {
	return available
		.filter(
			(model) =>
				model.provider === row.provider &&
				model.input.includes('text') &&
				model.contextWindow >= minimumContext
		)
		.slice(0, 3)
		.map((model) =>
			toRoutingModel(model, {
				billingMode: 'subscription',
				readiness: true,
				quotaAvailable: row.quotaAvailable,
				latencyEstimateMs: row.latencyEstimateMs,
				marginalInputCost: row.marginalInputCost,
				marginalOutputCost: row.marginalOutputCost,
				toolMode: 'compatibility'
			})
		)
}

function subscriptionModels(
	h: Harness,
	available: CatalogModel[],
	minimumContext: number
): RoutingModel[] {
	if (!h.config.subscriptionRouting) return []
	const status = readSubscriptionStatus()
	const ready = freshSubscriptionProviders(status, Date.now(), h.config.subscriptionStatusTtlMs)
	const skipped =
		status == null ? 0 : [status.cursor, status.antigravity].filter((row) => !row.ready).length
	h.stats.unavailableProviderSkips += skipped
	const out: RoutingModel[] = []
	for (const row of ready) {
		if (row.latencyEstimateMs > h.config.subscriptionMaxLatencyMs) continue
		const fromRegistry = subscriptionFromRegistry(row, available, minimumContext)
		out.push(...(fromRegistry.length ? fromRegistry : subscriptionFromCache(row, minimumContext)))
	}
	return out
}

function withCurrentModel(current: CatalogModel, models: RoutingModel[]): RoutingModel[] {
	const currentKey = `${current.provider}/${current.id}`
	if (models.some((model) => model.key === currentKey)) return models
	const isSubscription = current.provider === 'cursor' || current.provider === 'antigravity'
	return [
		toRoutingModel(current, {
			billingMode: isSubscription ? 'subscription' : 'api',
			toolMode: isSubscription ? 'compatibility' : 'native'
		}),
		...models
	]
}

export function routeModels(h: Harness, ctx: ExtensionContext): RoutingModel[] {
	const current = ctx.model
	if (!current || !h.config.modelRouting) return []
	const contextTokens = ctx.getContextUsage()?.tokens ?? 0
	const minimumContext = contextTokens + h.config.compactionReserveTokens
	const available = ctx.modelRegistry.getAvailable()
	const models = [
		...sameFamilyModels(available, current, minimumContext),
		...xaiModels(available, minimumContext),
		...subscriptionModels(h, available, minimumContext)
	]
	const byKey = new Map<string, RoutingModel>()
	for (const model of models) byKey.set(model.key, model)
	const ranked = [...byKey.values()]
		.sort(
			(left, right) =>
				left.marginalInputCost +
				left.marginalOutputCost -
				(right.marginalInputCost + right.marginalOutputCost)
		)
		.slice(0, 10)
	return withCurrentModel(current, ranked)
}