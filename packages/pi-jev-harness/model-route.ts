/**
 * Cost / subscription policy applied after Jev answers the route questions.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { choiceOf, type Answers, type RoutingModel } from './jev.ts'
import type { Harness, ThinkingLevel } from './types.ts'

export { routeModels, toRoutingModel } from './model-candidates.ts'

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

/** Thinking changes are per turn too; remember the level to restore at agent_end. */
function setTurnThinking(h: Harness, pi: ExtensionAPI, level: ThinkingLevel): void {
	h.restoreThinking ??= pi.getThinkingLevel()
	void automatic(() => pi.setThinkingLevel(level))
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
	setTurnThinking(h, pi, thinking.choice)
	h.stats.thinkingSwitches++
	return `thinking ${thinking.choice}`
}

/**
 * Dynamic Thinking Scaler for offline or fast execution turns.
 * Prevents 10-20s CoT thinking pauses on simple exploration, grep, and file inspection.
 */
export function scaleThinkingForTurn(
	h: Harness,
	pi: ExtensionAPI,
	kind: string,
	prompt: string
): string | undefined {
	const currentThinking = pi.getThinkingLevel()
	if (!currentThinking) return undefined

	let targetLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' = currentThinking as
		'off' | 'minimal' | 'low' | 'medium' | 'high'

	const isExplorationOrInspect =
		kind === 'explore' ||
		kind === 'run' ||
		kind === 'research' ||
		/\b(find|grep|search|where|list|show|check log|xem log|log|ls|inspect)\b/i.test(prompt)

	const isComplexTask =
		kind === 'change' &&
		/\b(refactor|architect|redesign|migrate|rewrite|deadlock|concurrency)\b/i.test(prompt)

	if (isExplorationOrInspect) {
		// During exploration or routine lookups, cap thinking at low to avoid heavy CoT latency
		if (currentThinking === 'high' || currentThinking === 'xhigh' || currentThinking === 'medium') {
			targetLevel = 'low'
		}
	} else if (isComplexTask) {
		if (currentThinking === 'low' || currentThinking === 'minimal' || currentThinking === 'off') {
			targetLevel = 'high'
		}
	}

	if (targetLevel !== currentThinking) {
		setTurnThinking(h, pi, targetLevel)
		h.stats.thinkingSwitches++
		return `thinking scaled ${currentThinking} -> ${targetLevel}`
	}
	return undefined
}

/**
 * Shadow row per decided turn: the plain route (the model already selected, as without JEV)
 * next to JEV's pick and the model that actually runs, so savings and agreement are measured
 * rather than assumed. Pattern from KiroCrew decisions/outcomes.py (Apache-2.0).
 */
export function recordShadow(
	h: Pick<Harness, 'stats' | 'log'>,
	applied: { provider: string; id: string; cost: { input: number; output: number } } | undefined,
	turn: {
		kind: string
		selected: { choice: string; confidence: number }
		currentKey: string
		baselineCost: number
	}
): void {
	const appliedKey = applied ? `${applied.provider}/${applied.id}` : turn.currentKey
	const appliedCost = applied ? applied.cost.input + applied.cost.output : turn.baselineCost
	const agree = appliedKey === turn.currentKey
	h.stats.shadowTurns++
	if (agree) h.stats.shadowAgree++
	h.stats.shadowBaselineCost += turn.baselineCost
	h.stats.shadowAppliedCost += appliedCost
	h.log({
		what: 'route-shadow',
		kind: turn.kind,
		baseline: turn.currentKey,
		jev: turn.selected.choice,
		confidence: turn.selected.confidence,
		applied: appliedKey,
		agree,
		baselineCost: turn.baselineCost,
		appliedCost
	})
}

/**
 * Learned routing from the RL engine's verified outcomes (candidate `history`, read from
 * rl-qtable.json). Exploitation only by default: among ready candidates that cost no more than
 * the current model, pick the best Q-value when it beats the current model's by `margin` and both
 * have at least `minTrials`. `epsilon` > 0 also tries an unproven cheaper-or-equal candidate.
 */
export function banditChoice(
	models: RoutingModel[],
	currentKey: string,
	currentCost: number,
	kind: string,
	opts: { minTrials?: number; margin?: number; epsilon?: number; random?: () => number } = {}
): RoutingModel | undefined {
	const { minTrials = 5, margin = 0.2, epsilon = 0, random = Math.random } = opts
	const needsNativeTools = kind !== 'answer'
	const eligible = models.filter(
		(m) =>
			m.key !== currentKey &&
			m.readiness &&
			m.quotaAvailable !== false &&
			!(needsNativeTools && m.toolMode === 'compatibility') &&
			m.marginalInputCost + m.marginalOutputCost <= currentCost
	)
	if (epsilon > 0 && eligible.length > 0 && random() < epsilon) {
		return eligible[Math.floor(random() * eligible.length)]
	}
	const current = models.find((m) => m.key === currentKey)?.history
	if (!current || current.trials < minTrials) return undefined
	const best = eligible
		.filter((m) => (m.history?.trials ?? 0) >= minTrials)
		.sort((a, b) => (b.history?.qValue ?? 0) - (a.history?.qValue ?? 0))[0]
	return best && (best.history?.qValue ?? 0) >= current.qValue + margin ? best : undefined
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
	h.stats.modelDecisions++
	const baselineCost = current.cost.input + current.cost.output

	// log: measure what JEV would pick, change nothing.
	if (h.config.mode !== 'on') {
		const wouldUse = target
			? ctx.modelRegistry.find(target.provider, target.key.slice(target.provider.length + 1))
			: undefined
		recordShadow(h, wouldUse, { kind: kind.choice, selected, currentKey, baselineCost })
		return `would use ${selected.choice} (${h.config.mode}, not applied)`
	}

	// The selected model is the user's root model; JEV may advise but never replace it.
	h.log({
		what: 'root-model-pinned',
		model: currentKey,
		jevRecommendation: selected.choice,
		confidence: selected.confidence,
		kind: kind.choice
	})
	const thinkingNote = applyThinkingPolicy(h, pi, answers)
	recordShadow(h, ctx.model, {
		kind: kind.choice,
		selected,
		currentKey,
		baselineCost: current.cost.input + current.cost.output
	})
	return [`root model kept (${currentKey})`, thinkingNote].filter(Boolean).join(', ')
}
