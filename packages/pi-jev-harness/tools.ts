import type {
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent
} from '@earendil-works/pi-coding-agent'

import {
	choiceOf,
	guardQuestions,
	loopQuestions,
	noulOf,
	resultQuestions,
	scoreOf,
	THRESHOLDS,
	type Answers
} from './jev.ts'
import { spill, spillHint } from './spill.ts'
import { active, READ_TOOLS, short, type Block, type Harness } from './types.ts'

const resultText = (event: ToolResultEvent): string =>
	event.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')

/** Deep key sort, so `{a,b}` and `{b,a}` count as the same call. */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value === null || typeof value !== 'object') return value
	return Object.fromEntries(
		Object.entries(value)
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => [k, sortKeys(v)])
	)
}

export const callKey = (tool: string, input: unknown): string =>
	`${tool}:${JSON.stringify(sortKeys(input))}`

/** Free nudges (no Jev call) at these repeat counts; Jev is asked from LOOP_CHECK_AT on. */
const REMIND_AT = new Set([3, 5, 8])

const LOOP_CHECK_AT = 5

/** Pattern from deepseek-harness repeat-tool-reminder (MIT): gentle first, then specific. */
export function repeatReminder(tool: string, repeats: number): string | undefined {
	if (!REMIND_AT.has(repeats)) return undefined
	if (repeats === 3) {
		return '[jev-harness: you have made this exact call 3 times. Read the earlier result before calling again; if the task is not done, change the approach or the arguments.]'
	}
	return `[jev-harness: ${repeats} identical ${tool} calls with the same arguments are not making progress. Do not repeat them; use the latest result, try something different, or finish if you have enough.]`
}

/** Append the repeat nudge to a tool result, on top of whatever trimming already did. */
export function withReminder(
	h: Harness,
	event: ToolResultEvent,
	patch: { content: ToolResultEvent['content'] } | undefined
): { content: ToolResultEvent['content'] } | undefined {
	if (!active(h) || !h.config.loop || h.config.mode !== 'on') return patch
	const key = callKey(event.toolName, event.input)
	const text = repeatReminder(event.toolName, h.recent.filter((r) => r.key === key).length)
	if (!text) return patch
	return { content: [...(patch?.content ?? event.content), { type: 'text', text }] }
}

/** Step 4: the same call five times in the last twelve gets a second opinion. */
function loopVerdict(
	h: Harness,
	answers: Answers,
	event: ToolCallEvent,
	repeats: number
): Block | undefined {
	h.loopChecked = true
	const stuck = noulOf(answers, 'stuck')
	if (stuck < THRESHOLDS.stuck) return undefined
	h.stats.loopsCaught++
	if (h.config.mode !== 'on') return undefined
	const advice =
		noulOf(answers, 'wrong_approach') >= 0.5
			? 'Try a different approach or ask the user.'
			: 'Check the earlier result before running it again.'
	return {
		block: true,
		reason: `jev-harness: this is the ${repeats}th time you ran the same ${event.toolName} call and Jev judges you are stuck (${stuck.toFixed(2)}). ${advice}`
	}
}

function guardReason(answers: Answers): string | null {
	const secrets = noulOf(answers, 'secrets')
	if (secrets >= THRESHOLDS.secrets) return `may expose credentials (${secrets.toFixed(2)})`
	const risk = scoreOf(answers, 'risk')
	if (risk.confidence < THRESHOLDS.askConfidence) return null
	const level = Math.round(risk.score)
	if (level === 3) return `destructive (${risk.confidence.toFixed(2)})`
	if (level === 2) return `hard to reverse (${risk.confidence.toFixed(2)})`
	return null
}

/** Step 5: destructive or secret-touching calls need a human. */
async function guardVerdict(
	h: Harness,
	answers: Answers,
	event: ToolCallEvent,
	ctx: ExtensionContext
): Promise<Block | undefined> {
	const reason = guardReason(answers)
	if (!reason) return undefined
	h.stats.guardAsked++
	h.status(ctx, `jev guard: ${reason}`)
	if (h.config.mode !== 'on') return undefined
	const what = event.toolName === 'bash' ? String(event.input.command) : short(event.input, 400)
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			`jev-harness: ${reason}`,
			`${event.toolName}: ${what}\n\nRun it?`
		)
		if (ok) return undefined
	}
	h.stats.guardBlocked++
	const who = ctx.hasUI ? 'The user declined.' : 'No one is here to confirm; ask the user first.'
	return { block: true, reason: `jev-harness blocked this call: ${reason}. ${who}` }
}

export async function onToolCall(
	h: Harness,
	event: ToolCallEvent,
	ctx: ExtensionContext
): Promise<Block | undefined> {
	try {
		if (!active(h)) return undefined
		const key = callKey(event.toolName, event.input)
		h.recent.push({ tool: event.toolName, key, input: event.input })
		if (h.recent.length > 12) h.recent.shift()
		const repeats = h.recent.filter((r) => r.key === key).length
		const checkLoop = h.config.loop && repeats >= LOOP_CHECK_AT && !h.loopChecked
		const checkGuard = h.config.guard && !READ_TOOLS.includes(event.toolName)
		if (!checkLoop && !checkGuard) return undefined
		const questions = { ...(checkLoop ? loopQuestions : {}), ...(checkGuard ? guardQuestions : {}) }
		const state = {
			task: h.task,
			tool: event.toolName,
			input: event.input,
			cwd: ctx.cwd,
			recentCalls: h.recent.map((c) => ({ tool: c.tool, input: short(c.input, 160) }))
		}
		const result = await h.jev('tool_call', state, questions, ctx)
		if (!result) return undefined
		if (checkLoop) {
			const blocked = loopVerdict(h, result.answers, event, repeats)
			if (blocked) return blocked
		}
		if (checkGuard) return guardVerdict(h, result.answers, event, ctx)
		return undefined
	} catch (err) {
		h.stats.errors++
		h.log({ what: 'error', error: err instanceof Error ? err.message : String(err) })
		return undefined
	}
}

/** Step 3: cut tool output the model does not need before it lands in context. */
export async function onToolResult(h: Harness, event: ToolResultEvent, ctx: ExtensionContext) {
	try {
		if (!active(h) || !h.config.trim || event.isError) return undefined
		// Clean file reads under 8000 chars are left intact; commands, searches, listings and large outputs get trimmed.
		if (!['bash', 'exec', 'grep', 'find', 'ls', 'fetch', 'read'].includes(event.toolName)) return undefined
		const full = resultText(event)
		if (event.toolName === 'read' && full.length < 8000) return undefined
		if (full.length < h.config.trimMinChars) return undefined
		const state = {
			task: h.task,
			tool: event.toolName,
			input: event.input,
			totalChars: full.length,
			head: full.slice(0, 1500),
			tail: full.slice(-500)
		}
		const result = await h.jev('result', state, resultQuestions, ctx)
		if (!result) {
			// Fast offline trimming fallback for large tool outputs to prevent context bloat
			if (full.length > Math.max(h.config.trimMinChars, 3500)) {
				const saved = spill(full, event.toolName)
				const cut = full.length - h.config.keepHeadChars
				const recover = saved ? spillHint(saved) : 'Re-run with a narrower filter if you need them.'
				const replacement = `${full.slice(0, h.config.keepHeadChars)}\n[jev-harness cut ${cut} chars to protect context window. ${recover}]`
				h.stats.trimmed++
				h.stats.charsSaved += full.length - replacement.length
				if (h.config.mode !== 'on') return undefined
				return { content: [{ type: 'text' as const, text: replacement }] }
			}
			return undefined
		}
		const keep = choiceOf(result.answers, 'keep')
		const relevant = noulOf(result.answers, 'relevant')
		const succeeded = noulOf(result.answers, 'succeeded') >= 0.5 ? 'successfully' : 'with problems'
		const dropping =
			keep.choice === 'drop' && relevant < THRESHOLDS.dropResult && keep.confidence >= 0.6
		const heading =
			!dropping &&
			keep.choice === 'head' &&
			keep.confidence >= 0.6 &&
			full.length > h.config.keepHeadChars
		// Keep what gets cut on disk so the model can read it back instead of re-running the call.
		const saved = dropping || heading ? spill(full, event.toolName) : undefined
		let replacement: string | null = null
		if (dropping) {
			const recover = saved ? spillHint(saved) : 'Re-run it if you need the output.'
			replacement = `[jev-harness dropped ${full.length} chars of ${event.toolName} output judged not needed for the task (relevance ${relevant.toFixed(2)}). It ran ${succeeded}. ${recover}]`
		} else if (heading) {
			const cut = full.length - h.config.keepHeadChars
			const recover = saved ? spillHint(saved) : 'Re-run with a narrower filter if you need them.'
			replacement = `${full.slice(0, h.config.keepHeadChars)}\n[jev-harness cut ${cut} more chars judged repetitive (relevance ${relevant.toFixed(2)}). ${recover}]`
		}
		if (!replacement) return undefined
		h.stats.trimmed++
		h.stats.charsSaved += full.length - replacement.length
		h.status(ctx, `jev trim: ${keep.choice}, saved ${full.length - replacement.length} chars`)
		if (h.config.mode !== 'on') return undefined
		return { content: [{ type: 'text' as const, text: replacement }] }
	} catch (err) {
		h.stats.errors++
		h.log({ what: 'error', error: err instanceof Error ? err.message : String(err) })
		return undefined
	}
}
