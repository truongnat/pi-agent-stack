import { closeSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent'

import { generateAdvisorBriefing } from './advisor.ts'
import { compactHistory } from './compactor.ts'
import { choiceOf, noulOf, relevanceQuestions, routingQuestions, THRESHOLDS } from './jev.ts'
import { applyModelPolicy, routeModels, scaleThinkingForTurn } from './model-route.ts'
import { active, short, THRESHOLD_ALWAYS_KEEP, type Candidate, type Harness } from './types.ts'


const STOPWORDS = new Set([
	'about',
	'after',
	'again',
	'before',
	'being',
	'could',
	'does',
	'doing',
	'every',
	'first',
	'from',
	'have',
	'here',
	'into',
	'just',
	'like',
	'make',
	'more',
	'most',
	'need',
	'only',
	'other',
	'please',
	'should',
	'some',
	'than',
	'that',
	'them',
	'then',
	'there',
	'these',
	'they',
	'this',
	'those',
	'through',
	'want',
	'what',
	'when',
	'where',
	'which',
	'while',
	'with',
	'work',
	'would',
	'your'
])

const READ_BYTES = 64 * 1024

const IGNORED_GLOBS = ['-g', '!node_modules', '-g', '!dist', '-g', '!.git']

type Region = { start: number; end: number }

type ReadRegions = { content: string; ranges: Region[]; hasMoreLines: boolean }

/** Words in the prompt that could name code: paths, file names, identifiers, quoted strings, then plain words. */
export function termsIn(prompt: string): string[] {
	const out = new Set<string>()
	for (const m of prompt.matchAll(/`([^`]{2,80})`|"([^"]{2,80})"|'([^']{2,80})'/g)) {
		out.add((m[1] ?? m[2] ?? m[3] ?? '').trim())
	}
	for (const m of prompt.matchAll(
		/\b[\w.-]+\/[\w./-]+\b|\b[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|css|html|json|md|ya?ml|toml)\b/g
	)) {
		out.add(m[0])
	}
	for (const m of prompt.matchAll(
		/\b[a-z]+[A-Z][A-Za-z0-9]+\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/g
	)) {
		out.add(m[0])
	}
	for (const m of prompt.matchAll(/\b[a-z]{4,}\b/g)) {
		if (!STOPWORDS.has(m[0])) out.add(m[0])
	}
	return [...out].filter((term) => term.length >= 3 && !/^https?:/.test(term)).slice(0, 8)
}

/** `src/foo.ts` or `foo.ts`, not `v2.0` or `e.g.`: the extension must be letters. */
function looksLikeFile(term: string): boolean {
	return /^[\w./-]*\w\.[A-Za-z]{1,8}$/.test(term)
}

function fileArgs(term: string): string[] {
	const base = term.split('/').pop() ?? term
	return ['--files', '--max-filesize', '200K', '-g', `**/${base}`, ...IGNORED_GLOBS]
}

async function hasNamedFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	terms: string[]
): Promise<boolean> {
	const options = { cwd: ctx.cwd, timeout: 2000, ...(ctx.signal ? { signal: ctx.signal } : {}) }
	for (const term of terms) {
		if (!looksLikeFile(term)) continue
		const result = await pi.exec('rg', fileArgs(term), options).catch(() => null)
		const paths = (result?.stdout ?? '').split('\n').filter(Boolean)
		// A path in the prompt must match as a path, not just by basename.
		if (paths.some((path) => path === term || path.endsWith(`/${term}`))) return true
	}
	return false
}

async function candidateFiles(
	h: Harness,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	terms: string[],
	sent: Set<string>
): Promise<Candidate[]> {
	const files = new Map<string, Candidate['matched']>()
	const options = { cwd: ctx.cwd, timeout: 2000, ...(ctx.signal ? { signal: ctx.signal } : {}) }
	for (const term of terms) {
		if (files.size >= h.config.prefetchMaxCandidates) break
		const args = [
			'-n',
			'-F',
			'--max-filesize',
			'200K',
			'--max-count',
			'1',
			'--max-columns',
			'200',
			...IGNORED_GLOBS,
			term,
			'.'
		]
		const result = await pi.exec('rg', args, options).catch(() => null)
		const hits = (result?.stdout ?? '').split('\n').filter(Boolean)
		if (hits.length > 20) continue
		for (const hit of hits) {
			if (files.size >= h.config.prefetchMaxCandidates) break
			const match = /^(.+?):(\d+):(.*)$/.exec(hit)
			if (!match) continue
			const [, path = '', at = '', text = ''] = match
			if (sent.has(path)) continue
			files.set(path, [
				...(files.get(path) ?? []),
				{ term, line: text.trim().slice(0, 120), at: Number(at) }
			])
		}
	}
	return [...files.entries()].map(([path, matched]) => ({ path, matched }))
}

function toolSchemaChars(pi: ExtensionAPI, names: string[]): number {
	return pi
		.getAllTools()
		.filter((tool) => names.includes(tool.name))
		.reduce(
			(total, tool) =>
				total + tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length,
			0
		)
}

export function readRegions(
	cwd: string,
	path: string,
	lineNumbers: number[],
	maxLines: number
): ReadRegions | null {
	try {
		const file = openSync(join(cwd, path), 'r')
		try {
			const buffer = Buffer.alloc(READ_BYTES)
			const size = readSync(file, buffer, 0, buffer.length, 0)
			const text = buffer.toString('utf8', 0, size)
			// Drop a cut-off last line when the file is bigger than the buffer, and the empty line after a final newline.
			const whole =
				size === READ_BYTES ? text.slice(0, text.lastIndexOf('\n')) : text.replace(/\n$/, '')
			const lines = whole.split('\n')
			const windows = lineNumbers
				.filter((line) => line > 0 && line <= lines.length)
				.sort((a, b) => a - b)
				.map((line) => ({ start: Math.max(1, line - 15), end: Math.min(lines.length, line + 15) }))
			const merged = windows.reduce<Region[]>((regions, window) => {
				const last = regions.at(-1)
				if (last && window.start <= last.end + 1) last.end = Math.max(last.end, window.end)
				else regions.push(window)
				return regions
			}, [])
			const ranges: Region[] = []
			let remaining = maxLines
			for (const region of merged) {
				if (remaining <= 0) break
				const end = Math.min(region.end, region.start + remaining - 1)
				ranges.push({ start: region.start, end })
				remaining -= end - region.start + 1
			}
			if (!ranges.length) return null
			const content = ranges
				.map((region) => {
					const body = lines
						.slice(region.start - 1, region.end)
						.map((line, index) => `${String(region.start + index).padStart(4)}  ${line}`)
						.join('\n')
					return `--- ${path}:${region.start}-${region.end}\n${body}`
				})
				.join('\n\n')
			const selectedLines = ranges.reduce((total, range) => total + range.end - range.start + 1, 0)
			return { content, ranges, hasMoreLines: size === READ_BYTES || selectedLines < lines.length }
		} finally {
			closeSync(file)
		}
	} catch {
		// Deleted or unreadable since rg listed it.
		return null
	}
}

/** Step 2: pick vague-prompt files worth reading before the model starts. */
async function prefetch(
	h: Harness,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string
): Promise<{ message?: string; note: string } | null> {
	const terms = termsIn(prompt)
	if (!terms.length) return null
	if (await hasNamedFile(pi, ctx, terms)) {
		h.stats.prefetchSkipped++
		return { note: 'named file in prompt, no pre-fetch' }
	}
	const list = await candidateFiles(h, pi, ctx, terms, h.sent)
	if (!list.length) return null
	const paths = list.map((file) => file.path)
	const result = await h.jev(
		'prefetch',
		{ task: prompt, files: list },
		relevanceQuestions(paths),
		ctx
	)
	if (!result) return null
	const first = choiceOf(result.answers, 'first')
	const picked = paths
		.map((path, index) => {
			const noul = noulOf(result.answers, `f${index}`)
			const confidence = path === first.choice ? first.confidence : 0
			return { path, score: Math.max(noul, confidence) }
		})
		.filter((file) => file.score >= THRESHOLDS.prefetchFile)
		.sort((a, b) => b.score - a.score)
		.slice(0, h.config.prefetchFiles)
	const parts = picked.flatMap((file) => {
		const candidate = list.find((item) => item.path === file.path)
		const read = readRegions(
			ctx.cwd,
			file.path,
			candidate?.matched.map((match) => match.at) ?? [],
			h.config.prefetchLines
		)
		if (!read) return []
		if (h.config.mode === 'on') h.sent.add(file.path)
		return [{ path: file.path, read }]
	})
	if (!parts.length) return null
	h.stats.prefetched += parts.length
	const regions = parts.flatMap(({ path, read }) =>
		read.ranges.map((range) => `${path}:${range.start}-${range.end}`)
	)
	const moreLines = parts.filter((part) => part.read.hasMoreLines).map((part) => part.path)
	const moreNote = moreLines.length
		? ` More lines outside the excerpt: ${moreLines.join(', ')}.`
		: ''
	const message = `Context pre-fetched by jev-harness for this request. These excerpts show matching regions.${moreNote}\n\n${parts.map((part) => part.read.content).join('\n\n')}`
	return { message, note: `pre-fetched ${regions.join(', ')}` }
}

function applyToolRouting(
	h: Harness,
	pi: ExtensionAPI,
	names: string[],
	kind: { choice: string; confidence: number },
	answers: Parameters<typeof noulOf>[0]
): { keep: string[]; note: string; hideTools: boolean } {
	const keep = names.filter(
		(name) =>
			THRESHOLD_ALWAYS_KEEP.includes(name) ||
			noulOf(answers, `use_${name}`) >= THRESHOLDS.toolNeeded
	)
	const hidden = names.filter((name) => !keep.includes(name))
	const hiddenSchemaChars = toolSchemaChars(pi, hidden)
	const hideTools =
		h.config.mode === 'on' &&
		kind.choice !== 'answer' &&
		hidden.length >= h.config.routeMinHiddenTools &&
		hiddenSchemaChars >= h.config.routeMinSchemaChars

	let note = `kind ${kind.choice} (${kind.confidence.toFixed(2)})`
	if (hideTools && hidden.length > 0) {
		note += ` · ${keep.length} tools (${hidden.length} hidden)`
	} else {
		note += ` · ${keep.length} tools`
	}

	if (hideTools) {
		h.allTools = names
		pi.setActiveTools(keep)
		h.stats.toolsHidden += hidden.length
		h.stats.routeHiddenTools++
	}
	if (h.config.mode === 'on' && kind.choice === 'unclear' && kind.confidence >= 0.7) {
		note += '; ask clarifying question'
	}
	return { keep, note, hideTools }
}

/** Step 1: ask which kind of turn this is and which tools it needs; hide the rest for the turn. */
async function route(
	h: Harness,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string
): Promise<{ kind: string; note: string; hideTools: boolean } | null> {
	const names = pi.getActiveTools()
	const models = routeModels(h, ctx, prompt)
	const tools = pi
		.getAllTools()
		.filter((tool) => names.includes(tool.name))
		.map((tool) => ({ name: tool.name, description: short(tool.description, 200) }))
	const result = await h.jev(
		'route',
		{
			prompt,
			cwd: ctx.cwd,
			tools,
			currentModel: ctx.model
				? {
						provider: ctx.model.provider,
						id: ctx.model.id,
						thinking: pi.getThinkingLevel(),
						inputCost: ctx.model.cost.input,
						outputCost: ctx.model.cost.output
					}
				: null,
			candidates: models,
			contextUsage: ctx.getContextUsage() ?? null
		},
		routingQuestions(names, models, h.config.modelRouting),
		ctx
	)
	if (!result) return null
	const kind = choiceOf(result.answers, 'kind')
	const modelNote = await applyModelPolicy(h, pi, ctx, result.answers, models)
	const toolsRouted = applyToolRouting(h, pi, names, kind, result.answers)
	let note = toolsRouted.note
	if (modelNote) note += `, ${modelNote}`
	return { kind: kind.choice, note, hideTools: toolsRouted.hideTools }
}

export async function onBeforeAgentStart(
	h: Harness,
	pi: ExtensionAPI,
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext
) {
	h.task = event.prompt
	h.recent.length = 0
	h.loopChecked = false
	if (!active(h)) return undefined
	h.stats.turns++
	if (h.config.route || h.config.prefetch || h.config.advisor)
		h.status(ctx, 'jev: analyzing task & choosing optimal path…')

	const terms = termsIn(event.prompt)
	const candidatePaths = terms.filter((term) => looksLikeFile(term))

	const routePromise = h.config.route ? route(h, pi, ctx, event.prompt) : Promise.resolve(null)
	const prefetchPromise = h.config.prefetch
		? prefetch(h, pi, ctx, event.prompt)
		: Promise.resolve(null)
	const advisorPromise =
		h.config.advisor !== false
			? generateAdvisorBriefing(h, pi, ctx, event.prompt, candidatePaths)
			: Promise.resolve(null)

	const [routed, fetched, advised] = await Promise.all([
		routePromise,
		prefetchPromise,
		advisorPromise
	]).catch((err: unknown) => {
		h.stats.errors++
		h.log({ what: 'error', error: err instanceof Error ? err.message : String(err) })
		return [null, null, null] as const
	})

	if (h.config.modelRouting !== false && !routed?.note?.includes('thinking')) {
		const thinkingScaled = scaleThinkingForTurn(
			h,
			pi,
			routed?.kind ?? advised?.category ?? 'unclear',
			event.prompt
		)
		if (thinkingScaled) {
			h.log({ what: 'thinking_scale', note: thinkingScaled })
		}
	}

	const notes = [advised?.summaryNote, routed?.note, fetched?.note].filter(
		(note): note is string => !!note
	)
	if (fetched?.message && ctx.hasUI) ctx.ui.notify(`jev ${fetched.note}`, 'info')
	h.status(ctx, notes[0] ? `jev: ${notes.join(' · ')}` : `jev ${h.config.mode}`)
	if (h.config.mode !== 'on') return undefined

	// Automatic Context Compaction on message history when enabled
	if (h.config.contextCompaction !== false && (event as any).messages && Array.isArray((event as any).messages)) {
		const compactionRes = compactHistory((event as any).messages, {
			thresholdChars: h.config.compactThresholdChars ?? 24_000
		})
		if (compactionRes.compactedCount > 0) {
			h.stats.compactionRuns++
			h.stats.compactionCharsSaved += compactionRes.charsSaved
			h.log({
				what: 'context_compaction',
				compactedCount: compactionRes.compactedCount,
				charsSaved: compactionRes.charsSaved
			})
		}
	}

	const messageParts: string[] = []
	if (advised?.briefingText) {
		messageParts.push(advised.briefingText)
	}
	if (routed?.hideTools) {
		messageParts.push(`jev-harness routed this turn: ${routed.note}. Tools not listed are hidden for this turn; say so if you need one.`)
	}
	if (fetched?.message) {
		messageParts.push(fetched.message)
	}

	return {
		...(messageParts.length > 0
			? { message: { customType: 'jev-harness', content: messageParts.join('\n\n'), display: false } }
			: {})
	}
}

