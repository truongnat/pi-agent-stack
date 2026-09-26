/**
 * consensus.ts: Multi-Agent Supervisor Consensus Gate & Autonomous Verification Tree.
 *
 * Implements:
 * 1. Multi-Provider Peer Review & Voting: Compares results from heterogeneous subagents.
 * 2. Consensus Gate: Computes agreement score, verification pass rates, and identifies conflicts.
 * 3. Arbitration Strategy: Detects semantic disagreements and suggests resolution paths.
 */
import type { SubagentExecutionResult } from './types.ts'

export type ConsensusVerdict = 'approved' | 'rejected' | 'disputed'

export interface ConsensusVote {
	subagentId: string
	role: string
	model: string
	passed: boolean
	confidence: number
	reason: string
}

export interface ConsensusResult {
	verdict: ConsensusVerdict
	agreementScore: number // 0.0 to 1.0
	votes: ConsensusVote[]
	passedCount: number
	totalCount: number
	providerDiversityMet: boolean
	summary: string
	arbitrationAdvice?: string
}

export interface ConsensusOptions {
	/** Minimum ratio of approvals required (default: 0.67 or 2/3) */
	approvalThreshold?: number
	/** Minimum number of independent providers involved */
	minDiverseProviders?: number
	/** Require 100% test pass if any tester agent participated */
	requireTestPassing?: boolean
}

const DEFAULT_OPTIONS: Required<ConsensusOptions> = {
	approvalThreshold: 0.66,
	minDiverseProviders: 2,
	requireTestPassing: true
}

/**
 * Extracts a structured vote from a subagent execution result.
 */
export function extractVoteFromResult(result: SubagentExecutionResult): ConsensusVote {
	const output = result.output || ''
	const error = result.error || ''

	if (result.status === 'failed' || result.status === 'killed' || error) {
		return {
			subagentId: result.id,
			role: result.role,
			model: result.name,
			passed: false,
			confidence: 0.9,
			reason: error || 'Subagent execution failed or was terminated'
		}
	}

	const lower = output.toLowerCase()

	// Tester evaluation
	if (result.role === 'tester') {
		const hasExplicitFailCount = /\b[1-9]\d*\s*(?:fail|failed|errors?)\b/i.test(lower)
		const hasAssertionError =
			lower.includes('assertionerror') ||
			lower.includes('unhandled rejection') ||
			lower.includes('error:')
		const hasGenericFailure =
			(lower.includes('test failed') ||
				lower.includes('tests failed') ||
				lower.includes('failing')) &&
			!lower.includes('0 fail')

		const testFailed = hasExplicitFailCount || hasAssertionError || hasGenericFailure
		const testPassed =
			(lower.includes('pass') ||
				lower.includes('0 fail') ||
				lower.includes('all tests passed') ||
				lower.includes('ok')) &&
			!testFailed

		return {
			subagentId: result.id,
			role: result.role,
			model: result.name,
			passed: testPassed,
			confidence: 0.95,
			reason: testPassed ? 'All test assertions verified' : 'Test failures detected'
		}
	}

	// Reviewer evaluation
	if (result.role === 'reviewer') {
		const approved =
			(lower.includes('approve') ||
				lower.includes('lgtm') ||
				lower.includes('clean') ||
				lower.includes('pass')) &&
			!lower.includes('reject') &&
			!lower.includes('security risk') &&
			!lower.includes('critical issue')

		return {
			subagentId: result.id,
			role: result.role,
			model: result.name,
			passed: approved,
			confidence: 0.85,
			reason: approved
				? 'Code review approved with clean score'
				: 'Reviewer identified issues or requested changes'
		}
	}

	// Coder or Researcher default evaluation
	const genericPassed = result.status === 'completed' && output.length > 0
	return {
		subagentId: result.id,
		role: result.role,
		model: result.name,
		passed: genericPassed,
		confidence: 0.8,
		reason: genericPassed ? 'Task completed successfully' : 'Empty or incomplete output'
	}
}

/**
 * Evaluates multi-agent consensus across execution results.
 */
export function evaluateConsensus(
	results: SubagentExecutionResult[],
	availableProviders: string[] = [],
	opts?: ConsensusOptions
): ConsensusResult {
	const options = { ...DEFAULT_OPTIONS, ...opts }

	if (!results || results.length === 0) {
		return {
			verdict: 'rejected',
			agreementScore: 0,
			votes: [],
			passedCount: 0,
			totalCount: 0,
			providerDiversityMet: false,
			summary: 'No subagent execution results provided for consensus evaluation.'
		}
	}

	const votes = results.map(extractVoteFromResult)
	const passedVotes = votes.filter((v) => v.passed)
	const passedCount = passedVotes.length
	const totalCount = votes.length

	const agreementScore = totalCount > 0 ? passedCount / totalCount : 0
	const providerDiversityMet = availableProviders.length >= options.minDiverseProviders

	// Check if tester role failed
	const testerVote = votes.find((v) => v.role === 'tester')
	const testBlocked = options.requireTestPassing && testerVote && !testerVote.passed

	let verdict: ConsensusVerdict = 'disputed'
	let arbitrationAdvice: string | undefined

	if (testBlocked) {
		verdict = 'rejected'
		arbitrationAdvice =
			'Tester agent reported failures; changes must not be merged until tests pass 100%.'
	} else if (agreementScore >= options.approvalThreshold) {
		verdict = 'approved'
	} else if (agreementScore <= 0.34) {
		verdict = 'rejected'
		arbitrationAdvice =
			'Majority of agents rejected the execution outcome. Re-evaluate strategy or ask user.'
	} else {
		verdict = 'disputed'
		arbitrationAdvice =
			'Split decision between agents. Supervisor arbitration required: review dissenting agent logs.'
	}

	const voteSummary = votes
		.map(
			(v) =>
				`  • [${v.role.toUpperCase()}] ${v.model}: ${v.passed ? '✓ APPROVE' : '✗ REJECT'} (${v.reason})`
		)
		.join('\n')

	const summary = [
		`### 🏛 Multi-Agent Consensus: ${verdict.toUpperCase()} (Score: ${(agreementScore * 100).toFixed(0)}%)`,
		`Approvals: ${passedCount}/${totalCount} agents (Threshold: ${(options.approvalThreshold * 100).toFixed(0)}%)`,
		`Provider Diversity: ${providerDiversityMet ? `✓ Met (${availableProviders.length} providers)` : `⚠ Below threshold (${availableProviders.length}/${options.minDiverseProviders})`}`,
		`Votes:`,
		voteSummary,
		arbitrationAdvice ? `\n*Arbitration*: ${arbitrationAdvice}` : ''
	]
		.filter(Boolean)
		.join('\n')

	return {
		verdict,
		agreementScore,
		votes,
		passedCount,
		totalCount,
		providerDiversityMet,
		summary,
		arbitrationAdvice
	}
}
