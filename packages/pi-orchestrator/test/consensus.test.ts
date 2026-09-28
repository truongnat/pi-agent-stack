import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateConsensus, extractVoteFromResult, parseVerdict } from '../src/consensus.ts'
import type { SubagentExecutionResult } from '../src/types.ts'

const result = (
	role: string,
	output: string,
	status: SubagentExecutionResult['status'] = 'completed'
): SubagentExecutionResult => ({
	id: `${role}-${output.length}`,
	role,
	name: `${role}_1`,
	status,
	output,
	...(status === 'failed' ? { error: 'Process crashed with OOM' } : {}),
	tokensUsed: 100,
	durationMs: 500,
	scratchpadDir: '/tmp'
})

test('verifiers vote with their VERDICT line, not with keywords', () => {
	assert.equal(parseVerdict('Looks fine.\n**VERDICT: PASS**'), 'PASS')
	assert.equal(parseVerdict('VERDICT: PASS\n...\nVERDICT: FAIL'), 'FAIL')
	assert.equal(parseVerdict('no verdict here'), undefined)

	// The old keyword scan approved these: "pass" in "password", "ok" in "token", "clean" in "unclean".
	const misleading = extractVoteFromResult(
		result('reviewer', 'The password token handling is unclean.\nVERDICT: FAIL')
	)
	assert.equal(misleading.passed, false)
	const silent = extractVoteFromResult(result('tester', 'Ran the suite, looks ok.'))
	assert.equal(silent.abstained, true)
	assert.equal(extractVoteFromResult(result('tester', '12 pass\nVERDICT: PASS')).passed, true)

	const crashed = extractVoteFromResult(result('coder', '', 'failed'))
	assert.equal(crashed.passed, false)
	assert.match(crashed.reason, /OOM/)
})

test('the primary does not vote for itself; a reviewer FAIL is not outvoted', () => {
	const coder = result('coder', 'Implemented auth middleware.')
	const pass = evaluateConsensus(
		[coder, result('reviewer', 'VERDICT: PASS'), result('tester', 'VERDICT: PASS')],
		['anthropic', 'openai']
	)
	assert.equal(pass.verdict, 'approved')
	assert.deepEqual([pass.passedCount, pass.totalCount], [2, 2])

	// Before: coder + tester = 2/3 >= 0.66 approved over the reviewer's rejection.
	const split = evaluateConsensus([
		coder,
		result('reviewer', 'Must fix: SQL injection.\nVERDICT: FAIL'),
		result('tester', 'VERDICT: PASS')
	])
	assert.notEqual(split.verdict, 'approved')

	const testerFail = evaluateConsensus([
		coder,
		result('reviewer', 'VERDICT: PASS'),
		result('tester', '1 fail\nVERDICT: FAIL')
	])
	assert.equal(testerFail.verdict, 'rejected')
	assert.match(testerFail.arbitrationAdvice || '', /Tester agent reported failures/)

	const nobody = evaluateConsensus([coder, result('reviewer', 'fine'), result('tester', 'ok')])
	assert.equal(nobody.verdict, 'disputed')
	assert.equal(nobody.totalCount, 0)
})

test('custom reviewer roles vote by VERDICT too, so the coder cannot approve itself', () => {
	const coder = result('coder', 'Implemented auth middleware.')
	const security = {
		...result('security', 'Token logged in plain text.\nVERDICT: FAIL'),
		id: 'sec'
	}
	const c = evaluateConsensus([coder, security], [], { verifierIds: ['sec'] })
	assert.equal(c.verdict, 'rejected')
	assert.deepEqual([c.passedCount, c.totalCount], [0, 1])
})
