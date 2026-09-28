import type { EvaluatorResult } from './types.ts'

declare global {
	var piAgentStackJev:
		| {
				evaluateGoal?: (params: {
					objective: string
					lastAssistantMessage: string
					toolSummary: string
				}) => Promise<{ met: boolean; confidence: number; reason: string }>
		  }
		| undefined
}

export async function evaluateGoalWithJev(params: {
	objective: string
	lastAssistantMessage: string
	toolSummary: string
	reason?: string
}): Promise<EvaluatorResult> {
	if (globalThis.piAgentStackJev?.evaluateGoal) {
		try {
			const res = await globalThis.piAgentStackJev.evaluateGoal(params)
			return {
				met: res.met,
				confidence: res.confidence,
				reason: res.reason
			}
		} catch (err) {
			// An evaluator outage is not evidence against the model's claim; rejecting here looped forever.
			return {
				met: true,
				confidence: 0.3,
				reason: `JEV evaluator unavailable (${err instanceof Error ? err.message : String(err)}); accepting the self-report`
			}
		}
	}

	// Built-in verification heuristic when JEV server is not running
	const trimmedReason = (params.reason || '').trim()
	const minReasonLength = 15

	if (!trimmedReason || trimmedReason.length < minReasonLength) {
		return {
			met: false,
			confidence: 0.8,
			reason: `Premature completion rejected: Reason "${trimmedReason}" is too brief. Provide a thorough summary of completed requirements and verification steps.`
		}
	}

	// Check if reason is just generic dismissal or single step
	// Anchored at both ends: "Completed all 4 requirements; 12/12 tests pass" is a real summary.
	const genericDismissals = [
		/^(done|ok|complete|completed|finished|all done|fixed|i am done|finished all)[\s.!]*$/i,
		/^turn complete[\s.!]*$/i,
		/^(step|phase|part|task)\s*\d+\s*(is\s*)?(done|complete|completed|finished|succeeded)(\s+successfully)?[\s.!]*$/i,
		/^completed (step|phase|part|task)\s*\d+[\s.!]*$/i
	]
	for (const pattern of genericDismissals) {
		if (pattern.test(trimmedReason)) {
			return {
				met: false,
				confidence: 0.9,
				reason: `Premature completion rejected: "${trimmedReason}" looks like a single step completion rather than full goal verification. Continue with remaining objectives or provide detailed proof.`
			}
		}
	}

	return {
		met: true,
		confidence: 0.7,
		reason: 'Goal verified against requirements.'
	}
}
