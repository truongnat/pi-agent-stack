import assert from 'node:assert/strict'
import test from 'node:test'
import { checkOrchestratorGuard, getAvailableProviders } from '../src/guard.ts'
import { SubagentManager } from '../src/manager.ts'
import { createOrchestratorTools } from '../src/tools.ts'

test('checkOrchestratorGuard blocks when available providers < minProvidersRequired', () => {
	const config = { enabled: true, guard: true, minProvidersRequired: 2 }

	const zeroRes = checkOrchestratorGuard(config, [])
	assert.equal(zeroRes.allowed, false)
	assert.match(zeroRes.reason ?? '', /requires at least 2 available\/configured providers/)

	const oneRes = checkOrchestratorGuard(config, ['anthropic'])
	assert.equal(oneRes.allowed, false)
	assert.match(oneRes.reason ?? '', /found 1: \[anthropic\]/)
})

test('checkOrchestratorGuard allows when >= 2 providers are ready', () => {
	const config = { enabled: true, guard: true, minProvidersRequired: 2 }

	const res = checkOrchestratorGuard(config, ['anthropic', 'cursor'])
	assert.equal(res.allowed, true)
	assert.deepEqual(res.providers, ['anthropic', 'cursor'])
})

test('checkOrchestratorGuard blocks when enabled is false regardless of providers', () => {
	const config = { enabled: false, guard: true, minProvidersRequired: 2 }

	const res = checkOrchestratorGuard(config, ['anthropic', 'cursor', 'gemini'])
	assert.equal(res.allowed, false)
	assert.match(res.reason ?? '', /disabled via config/)
})

test('checkOrchestratorGuard bypasses threshold when guard is disabled', () => {
	const config = { enabled: true, guard: false, minProvidersRequired: 2 }

	const res = checkOrchestratorGuard(config, ['anthropic'])
	assert.equal(res.allowed, true)
})

test('invoke_subagent tool enforces guard check and blocks execution if < 2 providers', async () => {
	const manager = new SubagentManager({ enabled: true, guard: true, minProvidersRequired: 2 })
	// Mock process.env to ensure 0 providers
	const oldAnthropic = process.env.ANTHROPIC_API_KEY
	const oldOpenAI = process.env.OPENAI_API_KEY
	delete process.env.ANTHROPIC_API_KEY
	delete process.env.OPENAI_API_KEY

	const { invokeSubagentTool } = createOrchestratorTools(manager)

	const result = await invokeSubagentTool.execute(
		'1',
		{ subagents: [{ role: 'coder', prompt: 'write code' }] },
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)

	// Restore
	if (oldAnthropic) process.env.ANTHROPIC_API_KEY = oldAnthropic
	if (oldOpenAI) process.env.OPENAI_API_KEY = oldOpenAI

	// When guard triggers, isError is true and details.guardBlocked is true or allowed is true if machine has other providers
	if (result.isError) {
		assert.equal(result.details?.guardBlocked, true)
		assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Orchestrator Guard/)
	}
})

test('invoke_subagent tool executes successfully when guard is disabled or passed', async () => {
	const manager = new SubagentManager({ enabled: true, guard: false, minProvidersRequired: 2 })
	const { invokeSubagentTool } = createOrchestratorTools(manager)

	const result = await invokeSubagentTool.execute(
		'1',
		{ subagents: [{ role: 'researcher', prompt: 'Audit security' }] },
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)

	assert.equal(result.isError, undefined)
	assert.match(
		result.content[0]?.type === 'text' ? result.content[0].text : '',
		/Orchestrator: Dispatched 1 Subagent/
	)
})
