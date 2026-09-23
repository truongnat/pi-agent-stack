import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { Question, Result } from './jev.ts'

export type Mode = 'on' | 'log' | 'off' // log = ask Jev and record, change nothing

export type Config = {
	mode: Mode
	route: boolean
	prefetch: boolean
	trim: boolean
	loop: boolean
	guard: boolean
	prefetchFiles: number
	prefetchLines: number
	trimMinChars: number
	keepHeadChars: number
	timeoutMs: number
	showStatus: boolean
	modelRouting: boolean
	modelSwitchConfidence: number
	thinkingSwitchConfidence: number
	routeMinHiddenTools: number
	routeMinSchemaChars: number
	prefetchMaxCandidates: number
	compactionReserveTokens: number
	subscriptionRouting: boolean
	subscriptionMaxLatencyMs: number
	subscriptionStatusTtlMs: number
}

export type Stats = {
	jevCalls: number
	jevMs: number
	jevTokens: number
	errors: number
	turns: number
	prefetchSkipped: number
	toolsHidden: number
	prefetched: number
	trimmed: number
	charsSaved: number
	loopsCaught: number
	guardAsked: number
	guardBlocked: number
	modelDecisions: number
	modelSwitches: number
	thinkingSwitches: number
	routeHiddenTools: number
	subscriptionDecisions: number
	providerFallbacks: number
	unavailableProviderSkips: number
	marginalCostAvoided: number
}

export type RecentCall = { tool: string; key: string; input: unknown }

export type Block = { block: true; reason: string }

export type Candidate = { path: string; matched: { term: string; line: string; at: number }[] }

export type Harness = {
	config: Config
	stats: Stats
	task: string
	allTools: string[] | null
	recent: RecentCall[]
	sent: Set<string>
	loopChecked: boolean
	status: (ctx: ExtensionContext, text?: string) => void
	log: (entry: Record<string, unknown>) => void
	jev: (
		what: string,
		state: unknown,
		questions: Record<string, Question>,
		ctx: ExtensionContext
	) => Promise<Result | null>
}

// DCP's compression tool must remain available so JEV's tool routing does not
// accidentally disable context pruning on long turns.
export const THRESHOLD_ALWAYS_KEEP = ['read', 'compress'] // never hide these, whatever Jev says

export const READ_TOOLS = ['read', 'grep', 'find', 'ls']

export const active = (h: Harness): boolean => h.config.mode !== 'off' && !!process.env.JEV_API_KEY

export const short = (value: unknown, max = 300): string => {
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	return text.length > max ? `${text.slice(0, max)}…` : text
}
