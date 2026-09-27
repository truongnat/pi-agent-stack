import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
	contextCompaction: boolean
	compactThresholdChars: number
	subscriptionRouting: boolean
	subscriptionMaxLatencyMs: number
	subscriptionStatusTtlMs: number
	advisor: boolean
	advisorMaxTokens: number
	advisorSkills: boolean
	advisorVerification: boolean
	thresholds?: import('./jev.ts').ThresholdConfig
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
	advisorBriefings: number
	compactionRuns: number
	compactionCharsSaved: number
	cachePrefixChecks: number
	cachePrefixViolations: number
	/** Shadow comparison: turns where JEV decided, and where it agreed with the plain route. */
	shadowTurns: number
	shadowAgree: number
	/** Summed list price ($/MTok in+out) of the plain route vs the route actually used. */
	shadowBaselineCost: number
	shadowAppliedCost: number
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

// DCP's compression tool, Goal tools, and Persona tools must remain available so JEV's tool routing does not
// accidentally disable context pruning, goal tracking, or persona feedback on long turns.
export const THRESHOLD_ALWAYS_KEEP = [
	'read',
	'compress',
	'get_goal',
	'update_goal',
	'get_persona',
	'update_persona',
	'feedback_persona',
	'invoke_subagent',
	'manage_subagents',
	'send_subagent_message'
]

export const READ_TOOLS = ['read', 'grep', 'find', 'ls']

export function ensureJevApiKey(): string | undefined {
	if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY
	try {
		const keyPath = join(homedir(), '.keys', 'jev.env')
		if (existsSync(keyPath)) {
			const content = readFileSync(keyPath, 'utf8')
			for (const line of content.split('\n')) {
				const match =
					line.match(/^export\s+JEV_API_KEY=["']?([^"'\s]+)["']?/) ||
					line.match(/^JEV_API_KEY=["']?([^"'\s]+)["']?/)
				if (match?.[1]) {
					process.env.JEV_API_KEY = match[1]
					return match[1]
				}
			}
		}
	} catch {
		// Ignore key load errors
	}
	return undefined
}

export const active = (h: Harness): boolean => {
	ensureJevApiKey()
	return h.config.mode !== 'off' && !!process.env.JEV_API_KEY
}

export const short = (value: unknown, max = 300): string => {
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	return text.length > max ? `${text.slice(0, max)}…` : text
}
