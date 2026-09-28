import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { emptyStats } from './index.ts'
import type { Answers, RoutingModel } from './jev.ts'
import { applyModelPolicy } from './model-route.ts'
import type { Config, Harness } from './types.ts'

const current = { provider: 'anthropic', id: 'claude-opus-5-5', cost: { input: 5, output: 25 } }

const cheap = { provider: 'openai-codex', id: 'gpt-6-luna', cost: { input: 1, output: 4 } }

const target: RoutingModel = {
	key: 'openai-codex/gpt-6-luna',
	provider: 'openai-codex',
	label: 'luna',
	inputCost: 1,
	outputCost: 4,
	contextWindow: 272_000,
	billingMode: 'api',
	readiness: true,
	latencyEstimateMs: 500,
	marginalInputCost: 1,
	marginalOutputCost: 4,
	toolMode: 'native'
}

const answers: Answers = {
	model: { type: 'choice', choice: target.key, confidence: 0.95 },
	kind: { type: 'choice', choice: 'answer', confidence: 0.9 },
	thinking: { type: 'choice', choice: 'keep_current', confidence: 0.9 }
} as unknown as Answers

function setup(mode: Config['mode']) {
	const setModel: string[] = []
	const h = {
		config: { mode, modelRouting: true, modelSwitchConfidence: 0.8, thinkingSwitchConfidence: 0.8 },
		stats: emptyStats(),
		log: () => undefined
	} as unknown as Harness
	const pi = {
		setModel: async (m: { id: string }) => {
			setModel.push(m.id)
			return true
		},
		getThinkingLevel: () => 'medium',
		setThinkingLevel: () => undefined
	} as unknown as ExtensionAPI
	const ctx = {
		model: current,
		modelRegistry: {
			find: (p: string, id: string) => (p === cheap.provider && id === cheap.id ? cheap : undefined)
		}
	} as unknown as ExtensionContext
	return { h, pi, ctx, setModel }
}

void test('log mode measures the pick but never switches the model', async () => {
	{
		const { h, pi, ctx, setModel } = setup('log')
		const note = await applyModelPolicy(h, pi, ctx, answers, [target])
		assert.deepEqual(setModel, [])
		assert.match(note ?? '', /not applied/)
		assert.equal(h.stats.shadowTurns, 1)
	}
})

void test('a routed switch remembers the user model so agent_end can restore it', async () => {
	const { h, pi, ctx, setModel } = setup('on')
	await applyModelPolicy(h, pi, ctx, answers, [target])
	assert.deepEqual(setModel, ['gpt-6-luna'])
	assert.equal(h.restoreModel?.id, 'claude-opus-5-5')
})
