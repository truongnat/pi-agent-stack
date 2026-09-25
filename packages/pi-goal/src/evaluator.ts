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
}): Promise<EvaluatorResult> {
	if (!globalThis.piAgentStackJev?.evaluateGoal) {
		return {
			met: true,
			confidence: 1,
			reason: 'JEV evaluator not available'
		}
	}

	try {
		const res = await globalThis.piAgentStackJev.evaluateGoal(params)
		return {
			met: res.met,
			confidence: res.confidence,
			reason: res.reason
		}
	} catch (err) {
		return {
			met: true,
			confidence: 0.5,
			reason: `JEV evaluator error: ${err instanceof Error ? err.message : String(err)}`
		}
	}
}
