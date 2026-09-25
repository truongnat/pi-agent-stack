import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ROSTER, getRoleDefinition } from '../src/roster.ts'

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
		'web_search'
	])
	assert.ok(DEFAULT_ROSTER.coder.allowedTools.includes('edit'))
	assert.ok(DEFAULT_ROSTER.tester.allowedTools.includes('bash'))
})

test('getRoleDefinition returns existing or fallback custom role', () => {
	const coder = getRoleDefinition('coder')
	assert.equal(coder.name, 'coder')

	const custom = getRoleDefinition('security-auditor')
	assert.equal(custom.name, 'security-auditor')
	assert.match(custom.label, /Custom Subagent/)
})
