import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildBudgetLimitPrompt,
	buildContinuationPrompt,
	buildObjectiveUpdatedPrompt,
	buildUserMessageReminder,
	escapeXml
} from '../src/prompts.ts'
import { createGoal } from '../src/state.ts'

test('escapeXml correctly escapes XML entities', () => {
	assert.equal(
		escapeXml('<objective id="1" test=\'true\'>a & b</objective>'),
		'&lt;objective id=&quot;1&quot; test=&apos;true&apos;&gt;a &amp; b&lt;/objective&gt;'
	)
})

test('buildContinuationPrompt includes escaped objective and turn count', () => {
	const goal = createGoal('Refactor <auth> module')
	goal.turns = 2
	const prompt = buildContinuationPrompt(goal, 'Make sure tests pass')

	assert.match(prompt, /\[Active Goal Loop · Turn 3\]/)
	assert.match(prompt, /&lt;auth&gt;/)
	assert.match(prompt, /\[Previous Turn Feedback \/ Evaluator Note\]: Make sure tests pass/)
	assert.match(prompt, /update_goal\(\{ status: "complete"/)
})

test('buildBudgetLimitPrompt includes token wrap-up notice', () => {
	const goal = createGoal('Large migration', 50000)
	goal.tokensUsed = 52000
	const prompt = buildBudgetLimitPrompt(goal)

	assert.match(prompt, /\[Goal Token Budget Limit Reached\]/)
	assert.match(prompt, /52000 tokens used/)
})

test('buildObjectiveUpdatedPrompt shows old and new objectives', () => {
	const prompt = buildObjectiveUpdatedPrompt('Old plan', 'New plan')
	assert.match(prompt, /<previous_objective>\nOld plan\n<\/previous_objective>/)
	assert.match(prompt, /<new_objective>\nNew plan\n<\/new_objective>/)
})

test('buildUserMessageReminder renders concise reminder', () => {
	const goal = createGoal('Fix login bug')
	goal.turns = 4
	const reminder = buildUserMessageReminder(goal)
	assert.match(reminder, /\[Active Goal Reminder: "Fix login bug" · Turn 4\]/)
})
