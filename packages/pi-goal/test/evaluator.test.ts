import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateGoalWithJev } from '../src/evaluator.ts'

test('evaluateGoalWithJev rejects brief or empty reasons without JEV server', async () => {
	const res = await evaluateGoalWithJev({
		objective: 'Implement OAuth provider',
		lastAssistantMessage: 'I am starting step 1.',
		toolSummary: 'read(file.ts)',
		reason: 'done'
	})

	assert.equal(res.met, false)
	assert.match(res.reason, /too brief/i)
})

test('evaluateGoalWithJev rejects generic single step dismissal', async () => {
	const res = await evaluateGoalWithJev({
		objective: 'Implement OAuth provider',
		lastAssistantMessage: 'I finished step 1.',
		toolSummary: 'read(file.ts)',
		reason: 'Step 1 completed successfully.'
	})

	assert.equal(res.met, false)
	assert.match(res.reason, /single step completion/i)
})

test('evaluateGoalWithJev accepts comprehensive verification reason', async () => {
	const res = await evaluateGoalWithJev({
		objective: 'Implement OAuth provider',
		lastAssistantMessage: 'Implemented OAuth and verified with 15 tests.',
		toolSummary: 'bash(bun test)',
		reason: 'OAuth implementation complete and all 15 tests pass.'
	})

	assert.equal(res.met, true)
})
