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
	THRESHOLDS,
	type Answers
} from './jev.ts'
import { evaluateRisk, type RiskEvaluation } from './risk.ts'
import { spill, spillHint } from './spill.ts'
import { active, ensureJevApiKey, READ_TOOLS, short, type Block, type Harness } from './types.ts'

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

/**
 * Enhanced semantic key extractor: identifies not just exact identical string calls,
 * but semantic edit loops targeting the same file path or identical search queries.
 */
export const callKey = (tool: string, input: unknown): string => {
	if (input && typeof input === 'object') {
		const rec = input as Record<string, unknown>
		// If editing the same file repeatedly
		if (tool === 'edit' || tool === 'write' || tool === 'read') {
			const targetFile = rec.path || rec.file || rec.TargetFile || ''
			if (targetFile) {
				return `${tool}:${targetFile}:${JSON.stringify(sortKeys(input))}`
			}
		}
	}
	return `${tool}:${JSON.stringify(sortKeys(input))}`
}

/** Check if the same target file has been edited/written 3+ times without progress */
export function targetFileLoopKey(tool: string, input: unknown): string | null {
	if (!input || typeof input !== 'object') return null
	const rec = input as Record<string, unknown>
	const target = rec.path || rec.file || rec.TargetFile || ''
	if ((tool === 'edit' || tool === 'write') && target) {
		return `file_mutation:${target}`
	}
	return null
}

/** Free nudges (no Jev call) at these repeat counts; Jev is asked from LOOP_CHECK_AT on. */
const REMIND_AT = new Set([3, 5, 8])

const LOOP_CHECK_AT = 5

/** Pattern from deepseek-harness repeat-tool-reminder (MIT): gentle first, then specific. */
export function repeatReminder(
	tool: string,
	repeats: number,
	targetName?: string
): string | undefined {
	if (!REMIND_AT.has(repeats)) return undefined
	const targetContext = targetName ? ` on \`${targetName}\`` : ''
	if (repeats === 3) {
		return `[ ⚠ JEV Loop Guard: exact call repeated 3 times${targetContext}. Read previous result or change arguments. ]`
	}
	return `[ ⚠ JEV Loop Guard: ${repeats} identical ${tool} calls detected${targetContext} without progress. Use latest result or change approach. ]`
}

/** Append the repeat nudge to a tool result, on top of whatever trimming already did. */
export function withReminder(
	h: Harness,
	event: ToolResultEvent,
	patch: { content: ToolResultEvent['content'] } | undefined
): { content: ToolResultEvent['content'] } | undefined {
	if (!active(h) || !h.config.loop || h.config.mode !== 'on') return patch
	const key = callKey(event.toolName, event.input)
	const repeats = h.recent.filter((r) => r.key === key).length
	const text = repeatReminder(event.toolName, repeats)
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
		reason: `[ 🛑 JEV Loop Guard: Blocked call #${repeats} (${event.toolName}, stuck score: ${stuck.toFixed(2)}). ${advice} ]`
	}
}

export function isSafeProjectCommand(command: string): boolean {
	const dummyEvent: ToolCallEvent = {
		type: 'tool_call',
		toolCallId: 'safety_check',
		toolName: 'bash',
		input: { command }
	}
	return evaluateRisk(dummyEvent, process.cwd()).level === 0
}

export function isDangerousSecretAction(event: ToolCallEvent): boolean {
	return evaluateRisk(event, process.cwd()).category === 'credential_leak'
}

/** Step 5: Context-aware multi-tier security and hazard guard. */
async function guardVerdict(
	h: Harness,
	evalResult: RiskEvaluation,
	event: ToolCallEvent,
	ctx: ExtensionContext
): Promise<Block | undefined> {
	if (evalResult.level === 0) {
		return undefined
	}

	if (evalResult.blockDirectly) {
		h.stats.guardBlocked++
		const reason = evalResult.reason || 'Critical security hazard blocked directly'
		return {
			block: true,
			reason: `[ 🛑 JEV Security Guard: ${reason}. Action blocked directly for repository and credential safety. ]`
		}
	}

	if (evalResult.requireConfirm) {
		const reason = evalResult.reason || 'Action requires confirmation'
		h.stats.guardAsked++
		h.status(ctx, `jev guard: ${reason}`)
		if (h.config.mode !== 'on') return undefined
		const what =
			event.toolName === 'bash' ? String(event.input?.command || '') : short(event.input, 400)
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

	return undefined
}

/**
 * Jev is missing (no key) or failed: say so once per session and let the user choose regex-only
 * guarding or stop. `PI_JEV_REGEX_ONLY=1` is prior consent, for headless runs the user started.
 */
async function consentRegexOnly(
	h: Harness,
	ctx: ExtensionContext,
	why: string
): Promise<Block | undefined> {
	const shared = globalThis as { piJevRegexOnly?: boolean | undefined }
	h.regexOnly ??= shared.piJevRegexOnly
	if (h.regexOnly === undefined && process.env.PI_JEV_REGEX_ONLY === '1') h.regexOnly = true
	if (h.regexOnly === undefined && ctx.hasUI) {
		h.regexOnly = await ctx.ui.confirm(
			'jev-harness: JEV unavailable',
			`${why}\n\nContinue with the local regex guard only?`
		)
	}
	shared.piJevRegexOnly = h.regexOnly
	if (h.regexOnly) {
		h.status(ctx, 'guard: regex-only')
		return undefined
	}
	h.stats.guardBlocked++
	const who = ctx.hasUI
		? 'The user declined regex-only mode.'
		: 'No one is here to confirm; set JEV_API_KEY or run with PI_JEV_REGEX_ONLY=1.'
	return { block: true, terminate: true, reason: `jev-harness stopped: ${why} ${who}` }
}

export async function onToolCall(
	h: Harness,
	event: ToolCallEvent,
	ctx: ExtensionContext
): Promise<Block | undefined> {
	try {
		if (h.config.mode === 'off') return undefined
		const isRead = READ_TOOLS.includes(event.toolName)
		const checkGuard = h.config.guard && !isRead

		// Local rules first and without Jev: hard blocks, and `read` of credential stores.
		if (h.config.guard && (checkGuard || event.toolName === 'read')) {
			const local = evaluateRisk(event, ctx.cwd)
			if (local.level > 0) return await guardVerdict(h, local, event, ctx)
		}
		if (isRead) return undefined

		const hasKey = !!ensureJevApiKey()
		const key = callKey(event.toolName, event.input)
		h.recent.push({ tool: event.toolName, key, input: event.input })
		if (h.recent.length > 12) h.recent.shift()
		const repeats = h.recent.filter((r) => r.key === key).length
		const checkLoop = hasKey && h.config.loop && repeats >= LOOP_CHECK_AT && !h.loopChecked
		if (!checkLoop && !checkGuard) return undefined
		const enforce = h.config.mode === 'on'
		if (!hasKey) {
			return enforce && checkGuard
				? await consentRegexOnly(h, ctx, 'No JEV_API_KEY is configured.')
				: undefined
		}

		const questions = { ...(checkLoop ? loopQuestions : {}), ...(checkGuard ? guardQuestions : {}) }
		const state = {
			task: h.task,
			tool: event.toolName,
			input: event.input,
			cwd: ctx.cwd,
			recentCalls: h.recent.map((c) => ({ tool: c.tool, input: short(c.input, 160) }))
		}
		const result = await h.jev('tool_call', state, questions, ctx)
		if (!result) {
			return enforce && checkGuard
				? await consentRegexOnly(h, ctx, 'The JEV request failed (timeout or network error).')
				: undefined
		}
		if (checkLoop) {
			const blocked = loopVerdict(h, result.answers, event, repeats)
			if (blocked) return blocked
		}
		if (checkGuard)
			return await guardVerdict(h, evaluateRisk(event, ctx.cwd, result.answers), event, ctx)
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
		if (!['bash', 'exec', 'grep', 'find', 'ls', 'fetch', 'read'].includes(event.toolName))
			return undefined
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
				const replacement = `${full.slice(0, h.config.keepHeadChars)}\n[ ✂ JEV Trimmed: cut ${cut} chars to protect context window. ${recover} ]`
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
			replacement = `[ ✂ JEV Trimmed: dropped ${full.length} chars of ${event.toolName} output (relevance: ${relevant.toFixed(2)}, ran ${succeeded}). ${recover} ]`
		} else if (heading) {
			const cut = full.length - h.config.keepHeadChars
			const recover = saved ? spillHint(saved) : 'Re-run with a narrower filter if you need them.'
			replacement = `${full.slice(0, h.config.keepHeadChars)}\n[ ✂ JEV Trimmed: cut ${cut} repetitive chars (relevance: ${relevant.toFixed(2)}). ${recover} ]`
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
