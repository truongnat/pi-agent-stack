import assert from 'node:assert/strict'
import test from 'node:test'
import {
	DEFAULT_ROSTER,
	generateAgentCodename,
	getRoleDefinition,
	resolveRoleTools,
	ToolsNotAllowedError,
	withModelSuffix
} from '../src/roster.ts'

test('DEFAULT_ROSTER defines standard 4 agent roles with proper tool scoping', () => {
	assert.ok(DEFAULT_ROSTER.researcher)
	assert.ok(DEFAULT_ROSTER.coder)
	assert.ok(DEFAULT_ROSTER.tester)
	assert.ok(DEFAULT_ROSTER.reviewer)

	assert.equal(DEFAULT_ROSTER.researcher.defaultModelTier, 'flash')
	assert.equal(DEFAULT_ROSTER.coder.defaultModelTier, 'sonnet')
	assert.equal(DEFAULT_ROSTER.tester.defaultModelTier, 'mini')
	assert.equal(DEFAULT_ROSTER.reviewer.defaultModelTier, 'pro')

	assert.deepEqual(DEFAULT_ROSTER.researcher.allowedTools, [
		'read',
		'grep',
		'find',
		'ls',
		'bash',
		'redmine_get_issue',
		'redmine_search_issues'
	])
	assert.ok(DEFAULT_ROSTER.reviewer.allowedTools.includes('bash'))
	assert.ok(DEFAULT_ROSTER.coder.allowedTools.includes('edit'))
	assert.ok(DEFAULT_ROSTER.coder.allowedTools.includes('bash'))
	assert.match(DEFAULT_ROSTER.coder.systemPrompt, /SELF-TEST/)
	assert.ok(DEFAULT_ROSTER.tester.allowedTools.includes('bash'))
	assert.match(DEFAULT_ROSTER.tester.systemPrompt, /second pass/)
})

test('resolveRoleTools keeps the full allowlist, subsets, and rejects extras', () => {
	const coder = getRoleDefinition('coder')
	assert.deepEqual(resolveRoleTools(coder), coder.allowedTools)
	assert.deepEqual(resolveRoleTools(coder, ['read', 'bash']), ['read', 'bash'])
	assert.throws(
		() => resolveRoleTools(getRoleDefinition('researcher'), ['read', 'write']),
		(err: unknown) => {
			assert.ok(err instanceof ToolsNotAllowedError)
			assert.deepEqual(err.extra, ['write'])
			return true
		}
	)
})

test('getRoleDefinition returns existing or fallback custom role', () => {
	const coder = getRoleDefinition('coder')
	assert.equal(coder.name, 'coder')

	const custom = getRoleDefinition('security-auditor')
	assert.equal(custom.name, 'security-auditor')
	assert.match(custom.label, /Custom Subagent/)
})

test('generateAgentCodename generates prestigious codenames based on role and prompt', () => {
	const researcherName = generateAgentCodename(
		'researcher',
		undefined,
		'Survey repository architecture'
	)
	assert.match(researcherName, / - Researcher - Senior$/)

	const coderName = generateAgentCodename('coder', 'CustomCoder')
	assert.equal(coderName, 'CustomCoder - Coder - Senior')

	const existingFormatted = generateAgentCodename('tester', 'Sentinel - Tester - Senior')
	assert.equal(existingFormatted, 'Sentinel - Tester - Senior')

	const withModel = generateAgentCodename(
		'coder',
		'Wozniak',
		undefined,
		'Senior',
		'openai-codex/gpt-5.5'
	)
	assert.equal(withModel, 'Wozniak - Coder - Senior - (openai-codex/gpt-5.5)')

	const existingPlusModel = generateAgentCodename(
		'tester',
		'Sentinel - Tester - Senior',
		undefined,
		'Senior',
		'antigravity/gemini-3-flash'
	)
	assert.equal(existingPlusModel, 'Sentinel - Tester - Senior - (antigravity/gemini-3-flash)')

	assert.equal(
		withModelSuffix('Wozniak - Coder - Senior - (old)', 'antigravity/gemini-3-flash'),
		'Wozniak - Coder - Senior - (antigravity/gemini-3-flash)'
	)
})
