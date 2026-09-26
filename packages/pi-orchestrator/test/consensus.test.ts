import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateConsensus, extractVoteFromResult } from '../src/consensus.ts'
import type { SubagentExecutionResult } from '../src/types.ts'

test('extractVoteFromResult extracts accurate votes across roles', () => {
	// 1. Tester passed
	const testerPass: SubagentExecutionResult = {
		id: 's1',
		role: 'tester',
		name: 'tester_1',
		status: 'completed',
		output: 'bun test\n✓ 12 pass\n0 fail\nRan 12 tests',
		tokensUsed: 100,
		durationMs: 500,
		scratchpadDir: '/tmp'
	}
	const vote1 = extractVoteFromResult(testerPass)
	assert.equal(vote1.passed, true)
	assert.match(vote1.reason, /verified/i)

	// 2. Tester failed
	const testerFail: SubagentExecutionResult = {
		id: 's2',
		role: 'tester',
		name: 'tester_2',
		status: 'completed',
		output: 'bun test\n✗ 1 tests failed:\nAssertionError',
		tokensUsed: 100,
		durationMs: 500,
		scratchpadDir: '/tmp'
	}
	const vote2 = extractVoteFromResult(testerFail)
	assert.equal(vote2.passed, false)
	assert.match(vote2.reason, /failure/i)

	// 3. Reviewer approved
	const reviewerPass: SubagentExecutionResult = {
		id: 's3',
		role: 'reviewer',
		name: 'reviewer_1',
		status: 'completed',
		output: 'Code changes look clean. LGTM, approved.',
		tokensUsed: 100,
		durationMs: 400,
		scratchpadDir: '/tmp'
	}
	const vote3 = extractVoteFromResult(reviewerPass)
	assert.equal(vote3.passed, true)

	// 4. Failed execution
	const subagentErr: SubagentExecutionResult = {
		id: 's4',
		role: 'coder',
		name: 'coder_1',
		status: 'failed',
		output: '',
		error: 'Process crashed with OOM',
		tokensUsed: 50,
		durationMs: 200,
		scratchpadDir: '/tmp'
	}
	const vote4 = extractVoteFromResult(subagentErr)
	assert.equal(vote4.passed, false)
	assert.match(vote4.reason, /OOM/)
})

test('evaluateConsensus calculates consensus verdict and provider diversity', () => {
	const coderResult: SubagentExecutionResult = {
		id: 'c1',
		role: 'coder',
		name: 'coder_1',
		status: 'completed',
		output: 'Implemented auth middleware.',
		tokensUsed: 200,
		durationMs: 800,
		scratchpadDir: '/tmp'
	}

	const reviewerResult: SubagentExecutionResult = {
		id: 'r1',
		role: 'reviewer',
		name: 'reviewer_1',
		status: 'completed',
		output: 'Approved with clean score.',
		tokensUsed: 150,
		durationMs: 600,
		scratchpadDir: '/tmp'
	}

	const testerResult: SubagentExecutionResult = {
		id: 't1',
		role: 'tester',
		name: 'tester_1',
		status: 'completed',
		output: 'All tests passed (10 pass, 0 fail).',
		tokensUsed: 150,
		durationMs: 600,
		scratchpadDir: '/tmp'
	}

	// Unanimous pass
	const consensusPass = evaluateConsensus(
		[coderResult, reviewerResult, testerResult],
		['anthropic', 'openai'],
		{ approvalThreshold: 0.66 }
	)

	assert.equal(consensusPass.verdict, 'approved')
	assert.equal(consensusPass.passedCount, 3)
	assert.equal(consensusPass.totalCount, 3)
	assert.equal(consensusPass.providerDiversityMet, true)
	assert.match(consensusPass.summary, /APPROVED/)

	// Tester failed -> blocks consensus
	const testerFailedResult: SubagentExecutionResult = {
		...testerResult,
		output: '1 fail: test failed on token verification'
	}

	const consensusBlocked = evaluateConsensus(
		[coderResult, reviewerResult, testerFailedResult],
		['anthropic', 'openai'],
		{ requireTestPassing: true }
	)

	assert.equal(consensusBlocked.verdict, 'rejected')
	assert.match(consensusBlocked.arbitrationAdvice || '', /Tester agent reported failures/)
})
