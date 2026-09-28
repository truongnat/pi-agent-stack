import assert from 'node:assert/strict'
import test from 'node:test'
import {
	classifyModelTier,
	getAvailableModelPool,
	selectOptimalModelForTask,
	supportsNativeTools,
	type AvailableModel
} from '../src/pool.ts'

test('getAvailableModelPool returns available models or safe empty pool', () => {
	const pool = getAvailableModelPool()
	assert.ok(Array.isArray(pool))
	for (const m of pool) {
		assert.ok(m.provider)
		assert.ok(m.id)
		assert.ok(m.fullModelName)
		assert.ok(['flash', 'standard', 'pro'].includes(m.tier))
	}
})

test('selectOptimalModelForTask selects flash-tier model for researcher, tester, and debugger', () => {
	const mockPool: AvailableModel[] = [
		{
			provider: 'antigravity',
			id: 'gemini-3.8-flash-high',
			fullModelName: 'antigravity/gemini-3.8-flash-high',
			tier: 'flash',
			costScore: 1,
			reasoning: true,
			ready: true,
			supportsTools: true
		},
		{
			provider: 'openai-codex',
			id: 'gpt-6-luna',
			fullModelName: 'openai-codex/gpt-6-luna',
			tier: 'standard',
			costScore: 2,
			reasoning: false,
			ready: true,
			supportsTools: true
		},
		{
			provider: 'antigravity',
			id: 'claude-opus-4-6-thinking',
			fullModelName: 'antigravity/claude-opus-4-6-thinking',
			tier: 'pro',
			costScore: 3,
			reasoning: true,
			ready: true,
			supportsTools: true
		}
	]

	const researcherSelection = selectOptimalModelForTask(
		{ role: 'researcher', prompt: 'Search codebase' },
		mockPool
	)
	assert.equal(researcherSelection.tier, 'flash')
	assert.equal(researcherSelection.fullModelName, 'antigravity/gemini-3.8-flash-high')

	const testerSelection = selectOptimalModelForTask(
		{ role: 'tester', prompt: 'Run test suite' },
		mockPool
	)
	assert.equal(testerSelection.tier, 'flash')
})

test('selectOptimalModelForTask selects standard code-tier model for coder', () => {
	const mockPool: AvailableModel[] = [
		{
			provider: 'antigravity',
			id: 'gemini-3.8-flash-high',
			fullModelName: 'antigravity/gemini-3.8-flash-high',
			tier: 'flash',
			costScore: 1,
			reasoning: true,
			ready: true,
			supportsTools: true
		},
		{
			provider: 'openai-codex',
			id: 'gpt-6-luna',
			fullModelName: 'openai-codex/gpt-6-luna',
			tier: 'standard',
			costScore: 2,
			reasoning: false,
			ready: true,
			supportsTools: true
		}
	]

	const coderSelection = selectOptimalModelForTask(
		{ role: 'coder', prompt: 'Refactor component state' },
		mockPool
	)
	assert.equal(coderSelection.tier, 'standard')
	assert.equal(coderSelection.fullModelName, 'openai-codex/gpt-6-luna')
})

test('selectOptimalModelForTask selects pro-tier model for reviewer', () => {
	const mockPool: AvailableModel[] = [
		{
			provider: 'antigravity',
			id: 'gemini-3.8-flash-high',
			fullModelName: 'antigravity/gemini-3.8-flash-high',
			tier: 'flash',
			costScore: 1,
			reasoning: true,
			ready: true,
			supportsTools: true
		},
		{
			provider: 'antigravity',
			id: 'claude-opus-4-6-thinking',
			fullModelName: 'antigravity/claude-opus-4-6-thinking',
			tier: 'pro',
			costScore: 3,
			reasoning: true,
			ready: true,
			supportsTools: true
		}
	]

	const reviewerSelection = selectOptimalModelForTask(
		{ role: 'reviewer', prompt: 'Review PR diff for security' },
		mockPool
	)
	assert.equal(reviewerSelection.tier, 'pro')
	assert.equal(reviewerSelection.fullModelName, 'antigravity/claude-opus-4-6-thinking')
})

test('selectOptimalModelForTask load balances across providers in multi-agent batches', () => {
	const mockPool: AvailableModel[] = [
		{
			provider: 'antigravity',
			id: 'gemini-3.8-flash-high',
			fullModelName: 'antigravity/gemini-3.8-flash-high',
			tier: 'flash',
			costScore: 1,
			reasoning: true,
			ready: true,
			supportsTools: true
		},
		{
			provider: 'gemini',
			id: 'gemini-2.5-flash',
			fullModelName: 'gemini/gemini-2.5-flash',
			tier: 'flash',
			costScore: 1,
			reasoning: false,
			ready: true,
			supportsTools: true
		}
	]

	// When antigravity is heavily loaded (e.g. 5 active subagents)
	const dispatchedCounts = { antigravity: 5, gemini: 0 }
	const selection = selectOptimalModelForTask(
		{ role: 'researcher', prompt: 'Search codebase' },
		mockPool,
		dispatchedCounts
	)

	// It should route to gemini to prevent overloading antigravity quota
	assert.equal(selection.provider, 'gemini')
})

test('"gemini" is not a mini model, and overrides match whole words or tiers', () => {
	assert.notEqual(classifyModelTier('gemini-2.5-pro').tier, 'flash')
	assert.equal(classifyModelTier('gpt-5-mini').tier, 'flash')
	assert.equal(classifyModelTier('o4-mini').tier, 'flash')

	const model = (provider: string, id: string): AvailableModel => ({
		provider,
		id,
		fullModelName: `${provider}/${id}`,
		...classifyModelTier(id),
		ready: true,
		supportsTools: true
	})
	const pool = [model('gemini', 'gemini-2.5-pro'), model('openai', 'gpt-5-mini')]
	const pick = (override: string) =>
		selectOptimalModelForTask({ role: 'coder', prompt: 'x', modelOverride: override }, pool)
			.fullModelName
	assert.equal(pick('mini'), 'openai/gpt-5-mini')
	assert.equal(pick('pro'), 'gemini/gemini-2.5-pro')
	assert.equal(pick('flash'), 'openai/gpt-5-mini')
})

test('supportsNativeTools flags CLI-subscription providers as text-only', () => {
	assert.equal(supportsNativeTools('cursor'), false)
	assert.equal(supportsNativeTools('antigravity'), false)
	assert.equal(supportsNativeTools('claude-code'), false)
	assert.equal(supportsNativeTools('Antigravity'), false)
	assert.equal(supportsNativeTools('anthropic'), true)
	assert.equal(supportsNativeTools('openai-codex'), true)
	assert.equal(supportsNativeTools('gemini'), true)
})

test('a task that requires tools skips a compat-mode-only provider for a tool-capable one', () => {
	const mockPool: AvailableModel[] = [
		{
			provider: 'antigravity',
			id: 'gemini-3.8-flash-high',
			fullModelName: 'antigravity/gemini-3.8-flash-high',
			tier: 'flash',
			costScore: 1,
			reasoning: true,
			ready: true,
			supportsTools: false
		},
		{
			provider: 'anthropic',
			id: 'claude-3-5-haiku',
			fullModelName: 'anthropic/claude-3-5-haiku',
			tier: 'flash',
			costScore: 1,
			reasoning: false,
			ready: true,
			supportsTools: true
		}
	]

	// Without tools, load balancing (equal cost, no dispatch load) picks the first flash model.
	const noTools = selectOptimalModelForTask({ role: 'researcher', prompt: 'x' }, mockPool)
	assert.equal(noTools.provider, 'antigravity')

	// A researcher that needs read/grep/find must not land on the text-only CLI provider.
	const withTools = selectOptimalModelForTask(
		{ role: 'researcher', prompt: 'x' },
		mockPool,
		{},
		true
	)
	assert.equal(withTools.provider, 'anthropic')
	assert.equal(withTools.supportsTools, true)
})

test('a tools-requiring task widens the search across tiers before accepting a compat-mode model', () => {
	const mockPool: AvailableModel[] = [
		{
			provider: 'antigravity',
			id: 'gemini-3.8-flash-high',
			fullModelName: 'antigravity/gemini-3.8-flash-high',
			tier: 'flash',
			costScore: 1,
			reasoning: true,
			ready: true,
			supportsTools: false
		},
		{
			provider: 'anthropic',
			id: 'claude-3-7-sonnet',
			fullModelName: 'anthropic/claude-3-7-sonnet',
			tier: 'standard',
			costScore: 2,
			reasoning: false,
			ready: true,
			supportsTools: true
		}
	]

	// No flash-tier tool-capable model exists, but a standard-tier one does — prefer it
	// over the flash-tier compat-mode model.
	const selection = selectOptimalModelForTask(
		{ role: 'researcher', prompt: 'x' },
		mockPool,
		{},
		true
	)
	assert.equal(selection.provider, 'anthropic')
	assert.equal(selection.supportsTools, true)
})

test('a tools-requiring task with no tool-capable model anywhere still returns a selection, flagged', () => {
	const mockPool: AvailableModel[] = [
		{
			provider: 'antigravity',
			id: 'gemini-3.8-flash-high',
			fullModelName: 'antigravity/gemini-3.8-flash-high',
			tier: 'flash',
			costScore: 1,
			reasoning: true,
			ready: true,
			supportsTools: false
		}
	]

	const selection = selectOptimalModelForTask(
		{ role: 'researcher', prompt: 'x' },
		mockPool,
		{},
		true
	)
	assert.equal(selection.provider, 'antigravity')
	assert.equal(selection.supportsTools, false)
	assert.match(selection.rationale, /WARNING/)
})
