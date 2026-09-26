import assert from 'node:assert/strict'
import test from 'node:test'
import {
	getAvailableModelPool,
	selectOptimalModelForTask,
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
			ready: true
		},
		{
			provider: 'openai-codex',
			id: 'gpt-6-luna',
			fullModelName: 'openai-codex/gpt-6-luna',
			tier: 'standard',
			costScore: 2,
			reasoning: false,
			ready: true
		},
		{
			provider: 'antigravity',
			id: 'claude-opus-4-6-thinking',
			fullModelName: 'antigravity/claude-opus-4-6-thinking',
			tier: 'pro',
			costScore: 3,
			reasoning: true,
			ready: true
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
			ready: true
		},
		{
			provider: 'openai-codex',
			id: 'gpt-6-luna',
			fullModelName: 'openai-codex/gpt-6-luna',
			tier: 'standard',
			costScore: 2,
			reasoning: false,
			ready: true
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
			ready: true
		},
		{
			provider: 'antigravity',
			id: 'claude-opus-4-6-thinking',
			fullModelName: 'antigravity/claude-opus-4-6-thinking',
			tier: 'pro',
			costScore: 3,
			reasoning: true,
			ready: true
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
			ready: true
		},
		{
			provider: 'gemini',
			id: 'gemini-2.5-flash',
			fullModelName: 'gemini/gemini-2.5-flash',
			tier: 'flash',
			costScore: 1,
			reasoning: false,
			ready: true
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
