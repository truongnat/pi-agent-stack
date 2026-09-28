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
	/** No VERDICT line: the vote is shown but not counted. */
	abstained?: boolean
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
	/** Results that vote by VERDICT line regardless of role (custom reviewer_roles). */
	verifierIds?: string[]
}

const DEFAULT_OPTIONS: Required<ConsensusOptions> = {
	approvalThreshold: 0.66,
	minDiverseProviders: 2,
	requireTestPassing: true,
	verifierIds: []
}

export const VERIFIER_ROLES = new Set(['reviewer', 'tester'])

/** Last `VERDICT: PASS|FAIL` line in the output (markdown bold allowed). */
export function parseVerdict(output: string): 'PASS' | 'FAIL' | undefined {
	const matches = [...output.matchAll(/^[\s>*_`]*VERDICT[\s*_`]*:[\s*_`]*(PASS|FAIL)\b/gim)]
	const last = matches.at(-1)?.[1]
	return last ? (last.toUpperCase() as 'PASS' | 'FAIL') : undefined
}

/**
 * Extracts a structured vote from a subagent execution result.
 */
export function extractVoteFromResult(
	result: SubagentExecutionResult,
	isVerifier = VERIFIER_ROLES.has(result.role)
): ConsensusVote {
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

	// Reviewers and testers end with `VERDICT: PASS|FAIL` (their system prompts ask for it).
	// Keyword scans misread "token", "password" or "unclean", so without that line they abstain.
	if (isVerifier) {
		const verdict = parseVerdict(output)
		return {
			subagentId: result.id,
			role: result.role,
			model: result.name,
			passed: verdict === 'PASS',
			...(verdict ? {} : { abstained: true }),
			confidence: verdict ? 0.95 : 0,
			reason:
				verdict === 'PASS'
					? `${result.role} verdict: PASS`
					: verdict === 'FAIL'
						? `${result.role} verdict: FAIL`
						: 'No VERDICT line; not counted'
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

	const isVerifier = (r: SubagentExecutionResult) =>
		VERIFIER_ROLES.has(r.role) || options.verifierIds.includes(r.id)
	const votes = results.map((r) => extractVoteFromResult(r, isVerifier(r)))
	// When verifiers took part, the primary's own "I finished" is not a vote on its work; a
	// failed or killed run still counts against.
	const hasVerifiers = results.some(isVerifier)
	const counted = votes.filter(
		(v, i) =>
			!v.abstained &&
			(!hasVerifiers ||
				(results[i] !== undefined && isVerifier(results[i])) ||
				results[i]?.status === 'failed' ||
				results[i]?.status === 'killed')
	)
	const passedCount = counted.filter((v) => v.passed).length
	const totalCount = counted.length

	const agreementScore = totalCount > 0 ? passedCount / totalCount : 0
	const providerDiversityMet = availableProviders.length >= options.minDiverseProviders

	// Check if tester role failed
	const testerVote = counted.find((v) => v.role === 'tester')
	const testBlocked = options.requireTestPassing && testerVote && !testerVote.passed

	let verdict: ConsensusVerdict = 'disputed'
	let arbitrationAdvice: string | undefined

	if (totalCount === 0) {
		verdict = 'disputed'
		arbitrationAdvice =
			'No verifier gave a VERDICT line. Read their reports below and decide, or ask the user.'
	} else if (testBlocked) {
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
				`  • [${v.role.toUpperCase()}] ${v.model}: ${v.abstained ? '– ABSTAIN' : v.passed ? '✓ APPROVE' : '✗ REJECT'} (${v.reason})`
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
