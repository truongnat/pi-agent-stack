import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import {
	evaluateOfflineAdvisor,
	formatAdvisorBriefingText,
	generateAdvisorBriefing
} from './advisor.ts'
import { emptyStats } from './index.ts'
import { onBeforeAgentStart } from './route.ts'
import type { Harness } from './types.ts'

function createMockHarness(overrides: Partial<Harness['config']> = {}): Harness {
	return {
		config: {
			mode: 'on',
			route: true,
			prefetch: true,
			trim: true,
			loop: true,
			guard: true,
			prefetchFiles: 1,
			prefetchLines: 80,
			trimMinChars: 6000,
			keepHeadChars: 2000,
			timeoutMs: 3000,
			showStatus: true,
			modelRouting: false,
			modelSwitchConfidence: 0.82,
			thinkingSwitchConfidence: 0.75,
			routeMinHiddenTools: 2,
			routeMinSchemaChars: 4500,
			prefetchMaxCandidates: 20,
			compactionReserveTokens: 16384,
			subscriptionRouting: false,
			subscriptionMaxLatencyMs: 20000,
			subscriptionStatusTtlMs: 300000,
			advisor: true,
			advisorMaxTokens: 150,
			advisorSkills: true,
			advisorVerification: true,
			...overrides
		},
		stats: emptyStats(),
		task: '',
		allTools: null,
		recent: [],
		sent: new Set(),
		loopChecked: false,
		status: () => {},
		log: () => {},
		jev: async () => null
	}
}

function createMockContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		signal: undefined,
		ui: {
			notify: () => {},
			setStatus: () => {}
		}
	} as unknown as ExtensionContext
}

function createMockExtensionAPI(): ExtensionAPI {
	return {
		getActiveTools: () => ['read', 'edit', 'exec'],
		getAllTools: () => [
			{ name: 'read', description: 'Read file contents' },
			{ name: 'edit', description: 'Edit file' },
			{ name: 'exec', description: 'Execute shell command' }
		],
		setActiveTools: () => {},
		getThinkingLevel: () => 'medium',
		setThinkingLevel: () => {},
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 })
	} as unknown as ExtensionAPI
}

test('evaluateOfflineAdvisor classifies bugfix and selects TDD guidance for failing tests', () => {
	const result = evaluateOfflineAdvisor('fix the failing test in auth service', process.cwd(), [
		'src/auth.ts'
	])
	assert.equal(result.category, 'bugfix')
	assert.equal(result.guidance, 'tdd_first')
	assert.ok(result.verification.includes('test'))
	assert.deepEqual(result.focusPaths, ['src/auth.ts'])
	assert.ok(result.briefingText.includes('[Harness Advisor Briefing]'))
	assert.ok(result.briefingText.includes('TDD: Reproduce/verify with failing test'))
})

test('evaluateOfflineAdvisor classifies bugfix and selects root_cause_first for runtime failures', () => {
	const result = evaluateOfflineAdvisor('app vẫn không load được hoặc bị crash', process.cwd(), [
		'apps/mobile'
	])
	assert.equal(result.category, 'bugfix')
	assert.equal(result.guidance, 'root_cause_first')
	assert.ok(result.briefingText.includes('Root-cause triaging: Identify target surface & inspect error logs/trace'))
})

test('evaluateOfflineAdvisor classifies refactor and sets invariant caution', () => {
	const result = evaluateOfflineAdvisor('refactor state manager to avoid memory leaks', process.cwd())
	assert.equal(result.category, 'refactor')
	assert.ok(result.invariantsScore >= 0.6)
	assert.ok(result.briefingText.includes('Caution: High architectural invariant sensitivity'))
})

test('evaluateOfflineAdvisor classifies research and avoids test verification requirement', () => {
	const result = evaluateOfflineAdvisor('explain how the subscription provider pool works', process.cwd())
	assert.equal(result.category, 'research')
	assert.equal(result.verification, 'none')
	assert.ok(result.briefingText.includes('No test verification needed'))
})

test('formatAdvisorBriefingText generates structured markdown', () => {
	const text = formatAdvisorBriefingText({
		category: 'feature',
		verification: 'unit_test',
		guidance: 'type_safety',
		invariantsScore: 0.3,
		focusPaths: ['src/feature.ts', 'test/feature.test.ts']
	})
	assert.ok(text.includes('[Harness Advisor Briefing]'))
	assert.ok(text.includes('• Objective: Feature Implementation'))
	assert.ok(text.includes('• Verification Target: Run test suite'))
	assert.ok(text.includes('• Engineering Guidance: Strict typing'))
	assert.ok(text.includes('• Relevant Files: src/feature.ts, test/feature.test.ts'))
})

test('generateAdvisorBriefing respects advisor: false config', async () => {
	const h = createMockHarness({ advisor: false })
	const ctx = createMockContext()
	const pi = createMockExtensionAPI()

	const result = await generateAdvisorBriefing(h, pi, ctx, 'implement new endpoint')
	assert.equal(result, null)
	assert.equal(h.stats.advisorBriefings, 0)
})

test('generateAdvisorBriefing increments advisorBriefings counter on generation', async () => {
	const h = createMockHarness({ advisor: true })
	const ctx = createMockContext()
	const pi = createMockExtensionAPI()

	const result = await generateAdvisorBriefing(h, pi, ctx, 'implement new endpoint', ['src/endpoint.ts'])
	assert.ok(result)
	assert.equal(h.stats.advisorBriefings, 1)
	assert.equal(result?.category, 'feature')
	assert.deepEqual(result?.focusPaths, ['src/endpoint.ts'])
})

test('generateAdvisorBriefing handles active JEV answers properly', async () => {
	process.env.JEV_API_KEY = 'mock_key'
	const h = createMockHarness({ advisor: true })
	h.jev = async () => ({
		answers: {
			category: { type: 'choice', choice: 'feature', confidence: 0.95, probabilities: {} },
			verification: { type: 'choice', choice: 'unit_test', confidence: 0.9, probabilities: {} },
			skill_guidance: { type: 'choice', choice: 'tdd_first', confidence: 0.88, probabilities: {} },
			invariants: { type: 'noul', noul: 0.85 }
		},
		inputTokens: 120,
		ms: 15
	})

	const ctx = createMockContext()
	const pi = createMockExtensionAPI()

	const result = await generateAdvisorBriefing(h, pi, ctx, 'add goal status persistence', ['packages/pi-goal/src/state.ts'])
	delete process.env.JEV_API_KEY

	assert.ok(result)
	assert.equal(result?.category, 'feature')
	assert.equal(result?.guidance, 'tdd_first')
	assert.equal(result?.invariantsScore, 0.85)
	assert.ok(result?.briefingText.includes('Caution: High architectural invariant sensitivity'))
})

test('onBeforeAgentStart injects advisor briefing into systemPrompt', async () => {
	process.env.JEV_API_KEY = 'mock_key'
	const h = createMockHarness({ advisor: true, route: false, prefetch: false })
	const ctx = createMockContext()
	const pi = createMockExtensionAPI()

	const event = {
		prompt: 'fix broken regex in validator',
		systemPrompt: 'Base system prompt instructions.'
	}

	const res = await onBeforeAgentStart(h, pi, event as any, ctx)
	delete process.env.JEV_API_KEY

	assert.ok(res?.systemPrompt)
	assert.ok(res.systemPrompt.includes('Base system prompt instructions.'))
	assert.ok(res.systemPrompt.includes('[Harness Advisor Briefing]'))
	assert.ok(res.systemPrompt.includes('Bugfix / Regression Resolution'))
})
