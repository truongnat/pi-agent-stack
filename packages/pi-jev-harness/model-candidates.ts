/**
 * Build the ranked model candidate list for a routing turn.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

type LearnedEntry = {
	taskType?: string
	model?: string
	qValue?: number
	trials?: number
	successes?: number
}

const RL_CONFIG_PATH = join(homedir(), '.pi', 'agent', 'rl-config.json')

const RL_QTABLE_PATH = join(homedir(), '.pi', 'agent', 'rl-qtable.json')

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLearnedEntry(value: unknown): value is LearnedEntry {
	if (!isRecord(value)) return false
	return (
		typeof value.taskType === 'string' &&
		typeof value.model === 'string' &&
		numberIsFinite(value.qValue) &&
		numberIsFinite(value.trials) &&
		numberIsFinite(value.successes)
	)
}

function taskTypeForPrompt(prompt: string): string {
	const normalized = prompt.toLowerCase()
	if (/\b(test|tests|testing|spec|specs)\b|unit test/.test(normalized)) {
		return 'test'
	}
	if (/\b(fix|bug|error)\b|lỗi|sửa/.test(normalized)) {
		return 'fix'
	}
	if (/\b(refactor|clean|optimize|optimise)\b/.test(normalized) || normalized.includes('tối ưu')) {
		return 'refactor'
	}
	return 'general'
}

function learningEnabled(): boolean {
	try {
		if (!existsSync(RL_CONFIG_PATH)) return true
		const config: unknown = JSON.parse(readFileSync(RL_CONFIG_PATH, 'utf8'))
		return !isRecord(config) || config.mode !== 'off'
	} catch {
		return false
	}
}

function readLearnedEntries(): LearnedEntry[] {
	if (!learningEnabled() || !existsSync(RL_QTABLE_PATH)) return []
	try {
		const entries: unknown = JSON.parse(readFileSync(RL_QTABLE_PATH, 'utf8'))
		return Array.isArray(entries) ? entries.filter(isLearnedEntry) : []
	} catch {
		return []
	}
}

function addVerifiedHistory(models: RoutingModel[], prompt: string): RoutingModel[] {
	const taskType = taskTypeForPrompt(prompt)
	const entries = readLearnedEntries()
	return models.map((model) => {
		const matching = entries.filter(
			(entry) =>
				entry.taskType === taskType &&
				entry.model === model.key &&
				numberIsFinite(entry.trials) &&
				numberIsFinite(entry.qValue)
		)
		const trials = matching.reduce((total, entry) => total + (entry.trials ?? 0), 0)
		if (trials < 3) return model
		const qValue =
			matching.reduce((total, entry) => total + (entry.qValue ?? 0) * (entry.trials ?? 0), 0) /
			trials
		const successes = matching.reduce((total, entry) => total + (entry.successes ?? 0), 0)
		const successRate = successes / trials
		return {
			...model,
			history: { trials, successRate, qValue },
			label: `${model.label}; verified history=${trials} trials, ${Math.round(successRate * 100)}% pass, Q=${qValue.toFixed(2)}`
		}
	})
}

function numberIsFinite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
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

export function routeModels(h: Harness, ctx: ExtensionContext, prompt = ''): RoutingModel[] {
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
	return addVerifiedHistory(withCurrentModel(current, ranked), prompt)
}
