/**
 * Cost / subscription policy applied after Jev answers the route questions.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { choiceOf, type Answers, type RoutingModel } from './jev.ts'
import { toRoutingModel } from './model-candidates.ts'
import {
	isSubscriptionProvider,
	needsForcedSubscriptionExit,
	redactSubscriptionLog,
	subscriptionAllowedForKind
} from './subscription.ts'
import type { Harness } from './types.ts'

export { routeModels, toRoutingModel } from './model-candidates.ts'

function pickNativeFallback(
	ctx: ExtensionContext,
	models: RoutingModel[],
	currentKey: string
): RoutingModel | undefined {
	const fromCandidates = models
		.filter(
			(model) =>
				model.key !== currentKey &&
				model.toolMode !== 'compatibility' &&
				model.readiness &&
				model.quotaAvailable !== false
		)
		.sort(
			(left, right) =>
				left.marginalInputCost +
				left.marginalOutputCost -
				(right.marginalInputCost + right.marginalOutputCost)
		)
	const preferred = fromCandidates.find((model) => model.key === 'openai-codex/gpt-5.6-luna')
	if (preferred) return preferred
	if (fromCandidates[0]) return fromCandidates[0]
	const luna = ctx.modelRegistry.find('openai-codex', 'gpt-5.6-luna')
	if (!luna) return undefined
	return toRoutingModel(luna, { billingMode: 'api', toolMode: 'native' })
}

/**
 * Marks the model and thinking changes JEV makes by itself, so extensions that remember the
 * user's own choices (saved defaults, per-provider memory) can skip them. The mark outlives the
 * call by one macrotask, so the select events the harness emits for it still see it.
 */
declare global {
	/** Count of model/thinking changes JEV is making right now (read by pi-subscription-providers). */
	var piAgentStackAutomaticChange: number | undefined
}

export async function automatic<T>(change: () => T | Promise<T>): Promise<T> {
	globalThis.piAgentStackAutomaticChange = (globalThis.piAgentStackAutomaticChange ?? 0) + 1
	try {
		return await change()
	} finally {
		setTimeout(() => {
			globalThis.piAgentStackAutomaticChange = Math.max(
				0,
				(globalThis.piAgentStackAutomaticChange ?? 1) - 1
			)
		}, 0)
	}
}

async function setRoutedModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	candidate: RoutingModel
): Promise<boolean> {
	const model = ctx.modelRegistry.find(
		candidate.provider,
		candidate.key.slice(candidate.provider.length + 1)
	)
	return !!(model && (await automatic(() => pi.setModel(model))))
}

async function forceExitSubscription(
	h: Harness,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: {
		kind: string
		selected: string
		currentKey: string
		target: RoutingModel | undefined
		models: RoutingModel[]
	}
): Promise<string> {
	const preferredNative =
		args.target &&
		args.target.toolMode !== 'compatibility' &&
		args.target.readiness &&
		args.target.quotaAvailable !== false
			? args.target
			: pickNativeFallback(ctx, args.models, args.currentKey)
	if (!preferredNative) {
		h.stats.providerFallbacks++
		return `subscription exit required for kind=${args.kind} but no native candidate found`
	}
	if (!(await setRoutedModel(pi, ctx, preferredNative))) {
		h.stats.providerFallbacks++
		return `subscription exit required for kind=${args.kind} but native fallback unavailable`
	}
	h.stats.modelSwitches++
	h.stats.providerFallbacks++
	h.log(
		redactSubscriptionLog({
			what: 'model-forced-native',
			from: args.currentKey,
			to: preferredNative.key,
			kind: args.kind,
			selected: args.selected
		})
	)
	return `model ${preferredNative.key} (forced off subscription for kind=${args.kind})`
}

function skipUnavailable(
	h: Harness,
	target: RoutingModel,
	choice: string,
	kind: string
): string | undefined {
	if (!target.readiness) {
		h.stats.unavailableProviderSkips++
		h.log(
			redactSubscriptionLog({
				what: 'model-skip-unavailable',
				choice,
				reason: 'readiness=false'
			})
		)
		return 'model kept (candidate unavailable)'
	}
	if (target.quotaAvailable === false) {
		h.stats.unavailableProviderSkips++
		h.log(
			redactSubscriptionLog({
				what: 'model-skip-quota',
				choice,
				reason: 'quotaAvailable=false'
			})
		)
		return 'model kept (candidate quota exhausted)'
	}
	if (target.toolMode === 'compatibility' && !subscriptionAllowedForKind(kind)) {
		h.stats.providerFallbacks++
		h.log(
			redactSubscriptionLog({
				what: 'model-skip-compatibility',
				choice,
				kind,
				reason: 'subscription blocked: turn needs native Pi tools'
			})
		)
		return `model kept (subscription blocked for kind=${kind}; needs native Pi tools)`
	}
	return undefined
}

async function tryCheaperSwitch(
	h: Harness,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: {
		kind: string
		selected: { choice: string; confidence: number }
		currentKey: string
		currentCost: number
		target: RoutingModel
	}
): Promise<string | undefined> {
	const cheaper =
		args.target.key !== args.currentKey &&
		args.selected.confidence >= h.config.modelSwitchConfidence &&
		args.target.marginalInputCost + args.target.marginalOutputCost < args.currentCost * 0.95
	if (!cheaper) return undefined
	if (!(await setRoutedModel(pi, ctx, args.target))) {
		h.stats.providerFallbacks++
		return 'model kept (candidate unavailable)'
	}
	h.stats.modelSwitches++
	if (args.target.billingMode === 'subscription') {
		h.stats.subscriptionDecisions++
		const avoided =
			args.currentCost - (args.target.marginalInputCost + args.target.marginalOutputCost)
		if (avoided > 0) h.stats.marginalCostAvoided += avoided
	} else if (isSubscriptionProvider(args.currentKey.split('/')[0] ?? '')) {
		h.stats.providerFallbacks++
	}
	h.log(
		redactSubscriptionLog({
			what: 'model-switch',
			from: args.currentKey,
			to: args.target.key,
			billingMode: args.target.billingMode,
			kind: args.kind,
			confidence: args.selected.confidence
		})
	)
	return `model ${args.target.key}`
}

function applyThinkingPolicy(h: Harness, pi: ExtensionAPI, answers: Answers): string | undefined {
	const thinking = choiceOf(answers, 'thinking')
	const currentThinking = pi.getThinkingLevel()
	if (
		thinking.choice === 'keep_current' ||
		thinking.choice === currentThinking ||
		thinking.confidence < h.config.thinkingSwitchConfidence
	) {
		return undefined
	}
	if (
		thinking.choice !== 'minimal' &&
		thinking.choice !== 'low' &&
		thinking.choice !== 'medium' &&
		thinking.choice !== 'high'
	) {
		return undefined
	}
	const level = thinking.choice
	void automatic(() => pi.setThinkingLevel(level))
	h.stats.thinkingSwitches++
	return `thinking ${thinking.choice}`
}

export async function applyModelPolicy(
	h: Harness,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	answers: Answers,
	models: RoutingModel[]
): Promise<string | undefined> {
	const current = ctx.model
	if (!current || !h.config.modelRouting) return undefined
	const selected = choiceOf(answers, 'model')
	const kind = choiceOf(answers, 'kind')
	const currentKey = `${current.provider}/${current.id}`
	const target = models.find((model) => model.key === selected.choice)
	const notes: string[] = []
	h.stats.modelDecisions++

	if (needsForcedSubscriptionExit(kind.choice, current.provider)) {
		notes.push(
			await forceExitSubscription(h, pi, ctx, {
				kind: kind.choice,
				selected: selected.choice,
				currentKey,
				target,
				models
			})
		)
	} else if (target) {
		const skipped = skipUnavailable(h, target, selected.choice, kind.choice)
		if (skipped) {
			notes.push(skipped)
		} else {
			const switched = await tryCheaperSwitch(h, pi, ctx, {
				kind: kind.choice,
				selected,
				currentKey,
				currentCost: current.cost.input + current.cost.output,
				target
			})
			notes.push(switched ?? `model kept (${selected.choice}, ${selected.confidence.toFixed(2)})`)
		}
	} else {
		notes.push(`model kept (${selected.choice}, ${selected.confidence.toFixed(2)})`)
	}

	const thinkingNote = applyThinkingPolicy(h, pi, answers)
	if (thinkingNote) notes.push(thinkingNote)
	return notes.join(', ')
}
