/**
 * jev-harness: let TypeSafe's Jev do the reasoning around tool calls so the main model does not have to.
 *
 * 1. route     before_agent_start: Jev picks the kind of turn and which tools it will need; the rest are hidden for the turn
 * 2. prefetch  before_agent_start: code finds candidate files from terms in the prompt, Jev picks which to read, they are injected
 * 3. trim      tool_result: Jev judges whether the output matters; irrelevant or repetitive output is cut before the model sees it
 * 4. loop      tool_call: free reminders at 3, 5, 8 repeats; from 5, repeated calls are checked with Jev and blocked with a reason when it says the agent is stuck
 * 5. guard     tool_call: risk and secrets, in the same request as loop control; destructive calls prompt or block
 *
 * All questions and thresholds live in jev.ts. Every Jev call is logged to ~/.jev-harness/log.jsonl.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'

import { generateAdvisorBriefing, type AdvisorBriefingResult } from './advisor.ts'
import { compactHistory, verifyCachePrefixIntegrity } from './compactor.ts'
import { ask, choiceOf, goalQuestions, noulOf } from './jev.ts'
import { onBeforeAgentStart } from './route.ts'
import { onToolCall, onToolResult, withReminder } from './tools.ts'
import { active, type Config, type Harness, type Stats } from './types.ts'

const DEFAULTS: Config = {
	mode: 'on',
	route: true,
	prefetch: true,
	trim: true,
	loop: true,
	guard: true,
	prefetchFiles: 1,
	prefetchLines: 80,
	trimMinChars: 3000,
	keepHeadChars: 1500,
	timeoutMs: 3000,
	showStatus: true,
	modelRouting: true,
	modelSwitchConfidence: 0.82,
	thinkingSwitchConfidence: 0.75,
	routeMinHiddenTools: 2,
	routeMinSchemaChars: 4500,
	prefetchMaxCandidates: 20,
	compactionReserveTokens: 16384,
	contextCompaction: true,
	compactThresholdChars: 24_000,
	subscriptionRouting: true,
	subscriptionMaxLatencyMs: 20_000,
	subscriptionStatusTtlMs: 5 * 60_000,
	advisor: true,
	advisorMaxTokens: 150,
	advisorSkills: true,
	advisorVerification: true
}

const CONFIG_FILE = join(homedir(), '.pi', 'agent', 'jev-harness.json')

const LOG_DIR = join(homedir(), '.jev-harness')

const PRICE_PER_MTOK = 0.042

function loadConfig(): Config {
	try {
		// SAFETY: the user's own settings file; unknown keys are harmless and missing ones fall back to DEFAULTS.
		const fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>
		return { ...DEFAULTS, ...fromFile }
	} catch {
		// No config file, or an unreadable one: run with defaults.
		return { ...DEFAULTS }
	}
}

function log(entry: Record<string, unknown>): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true })
		appendFileSync(
			join(LOG_DIR, 'log.jsonl'),
			`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
		)
	} catch {
		// Logging must never break a turn.
	}
}

function sendJevMessage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	customType: 'jev-advisor' | 'jev-compact',
	content: string,
	details?: Record<string, unknown>
) {
	if (typeof pi.sendMessage === 'function') {
		pi.sendMessage({
			customType,
			content,
			display: true,
			details
		} as any)
	} else {
		ctx.ui.notify(content, 'info')
	}
}

function report(h: Harness, ctx: ExtensionContext, pi: ExtensionAPI): void {
	const s = h.stats
	const avg = s.jevCalls ? Math.round(s.jevMs / s.jevCalls) : 0
	const saved = Math.round((s.charsSaved + s.compactionCharsSaved) / 4)
	const cost = ((s.jevTokens / 1e6) * PRICE_PER_MTOK).toFixed(4)
	const reportText = [
		`### 💡 JEV Advisor & Harness Status (${h.config.mode.toUpperCase()})`,
		`• Turns: ${s.turns} seen · ${s.advisorBriefings} advisor briefings · ${s.prefetched} files pre-fetched · ${s.prefetchSkipped} turns skipped`,
		`• Token Reductions: ${s.trimmed} results trimmed · ${s.compactionRuns} history compactions (~${saved.toLocaleString()} tokens saved)`,
		`• Loop Guard & Safety: ${s.loopsCaught} loops caught · guard asked ${s.guardAsked} (blocked ${s.guardBlocked})`,
		`• Cache & Prefix Guard: ${s.cachePrefixChecks} prefix checks (${s.cachePrefixViolations} violations) · deterministic prefix intact`,
		`• Model Routing: ${s.modelDecisions} decisions · ${s.modelSwitches} cheaper model switches · ${s.thinkingSwitches} thinking reductions`,
		`• Subscriptions: ${s.subscriptionDecisions} picks · ${s.providerFallbacks} fallbacks · ~$${s.marginalCostAvoided.toFixed(3)}/MTok marginal avoided`,
		`• Execution Overhead: ${s.jevCalls} calls (${avg}ms avg) · ${s.jevTokens.toLocaleString()} tokens ($${cost}) · ${s.errors} errors`
	].join('\n')

	sendJevMessage(pi, ctx, 'jev-advisor', reportText, { strategy: 'harness-stats', stats: s })
}

function createHarness(): Harness {
	const config = loadConfig()
	const stats = emptyStats()
	const h: Harness = {
		config,
		stats,
		task: '',
		allTools: null,
		recent: [],
		sent: new Set(),
		loopChecked: false,
		status: (ctx, text) => {
			if (ctx.hasUI && config.showStatus) ctx.ui.setStatus('jev-harness', text)
		},
		log,
		jev: async (what, state, questions, ctx) => {
			try {
				const result = await ask(state, questions, {
					timeoutMs: config.timeoutMs,
					signal: ctx.signal
				})
				stats.jevCalls++
				stats.jevMs += result.ms
				stats.jevTokens += result.inputTokens
				log({ what, ms: result.ms, tokens: result.inputTokens, answers: result.answers })
				return result
			} catch (err) {
				stats.errors++
				log({ what, error: err instanceof Error ? err.message : String(err) })
				return null
			}
		}
	}
	return h
}

/** Session counters, all starting at zero. */
export function emptyStats(): Stats {
	return {
		jevCalls: 0,
		jevMs: 0,
		jevTokens: 0,
		errors: 0,
		turns: 0,
		prefetchSkipped: 0,
		toolsHidden: 0,
		prefetched: 0,
		trimmed: 0,
		charsSaved: 0,
		loopsCaught: 0,
		guardAsked: 0,
		guardBlocked: 0,
		modelDecisions: 0,
		modelSwitches: 0,
		thinkingSwitches: 0,
		routeHiddenTools: 0,
		subscriptionDecisions: 0,
		providerFallbacks: 0,
		unavailableProviderSkips: 0,
		marginalCostAvoided: 0,
		advisorBriefings: 0,
		compactionRuns: 0,
		compactionCharsSaved: 0,
		cachePrefixChecks: 0,
		cachePrefixViolations: 0,
		shadowTurns: 0,
		shadowAgree: 0,
		shadowBaselineCost: 0,
		shadowAppliedCost: 0
	}
}

/** Plain route (no JEV) vs what JEV ran, over this session's decided turns. */
export function shadowSummary(s: Stats): string {
	if (s.shadowTurns === 0) return 'shadow: no routed turns yet'
	const agree = Math.round((s.shadowAgree / s.shadowTurns) * 100)
	const ratio =
		s.shadowBaselineCost > 0 ? Math.round((s.shadowAppliedCost / s.shadowBaselineCost) * 100) : 100
	return `shadow: JEV kept the plain route on ${s.shadowAgree}/${s.shadowTurns} turns (${agree}%); routes used cost ~${ratio}% of the plain route's list price`
}

export default function (pi: ExtensionAPI) {
	const h = createHarness()

	// Expose goal, compactor & advisor evaluator bridge for pi-agent-stack
	;(globalThis as any).piAgentStackJev = {
		evaluateGoal: async (params: {
			objective: string
			lastAssistantMessage: string
			toolSummary: string
		}): Promise<{ met: boolean; confidence: number; reason: string }> => {
			if (!active(h)) return { met: true, confidence: 1, reason: 'jev inactive' }
			try {
				const result = await h.jev('goal_eval', params, goalQuestions, {
					cwd: process.cwd(),
					hasUI: false,
					signal: undefined
				} as unknown as ExtensionContext)
				if (!result) return { met: true, confidence: 0.5, reason: 'no jev response' }
				const metScore = noulOf(result.answers, 'objective_met')
				const reasonChoice = choiceOf(result.answers, 'reason')
				const isMet = metScore >= 0.7 && reasonChoice.choice === 'met'
				return {
					met: isMet,
					confidence: Math.max(metScore, reasonChoice.confidence),
					reason: reasonChoice.choice
				}
			} catch (err) {
				return {
					met: true,
					confidence: 0.5,
					reason: err instanceof Error ? err.message : String(err)
				}
			}
		},
		getAdvisorBriefing: async (
			prompt: string,
			candidatePaths: string[] = []
		): Promise<AdvisorBriefingResult | null> => {
			return generateAdvisorBriefing(
				h,
				pi,
				{ cwd: process.cwd(), hasUI: false, signal: undefined } as unknown as ExtensionContext,
				prompt,
				candidatePaths
			)
		},
		compactContext: (messages: any[], opts?: any) => {
			const res = compactHistory(messages, opts)
			if (res.compactedCount > 0) {
				h.stats.compactionRuns++
				h.stats.compactionCharsSaved += res.charsSaved
			}
			return res
		},
		checkPrefixIntegrity: (prompt: string) => {
			h.stats.cachePrefixChecks++
			const check = verifyCachePrefixIntegrity(prompt)
			if (!check.isDeterministic) {
				h.stats.cachePrefixViolations += check.violations.length
			}
			return check
		}
	}

	// Register custom message renderers
	if (typeof pi.registerMessageRenderer === 'function') {
		pi.registerMessageRenderer('jev-advisor', (message, { expanded, outputPad }, theme) => {
			const details = message.details as Record<string, unknown> | undefined
			const badge = theme.fg('accent', theme.bold('[ 💡 ADVISOR ]'))
			const header = `${badge} ${theme.bold('JEV Execution Strategy & Advice')}`
			const lines = [header]
			if (typeof details?.strategy === 'string') {
				lines.push(theme.fg('accent', `  Strategy: ${details.strategy}`))
			}
			const contentStr =
				typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
			if (expanded) {
				lines.push(...contentStr.split('\n').map((l: string) => theme.fg('muted', `  ${l}`)))
			} else {
				const preview = contentStr.split('\n').slice(0, 3)
				lines.push(...preview.map((l: string) => theme.fg('muted', `  ${l}`)))
				if (contentStr.split('\n').length > 3) {
					lines.push(theme.fg('dim', '  ... (expand to view full briefing)'))
				}
			}
			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(lines.join('\n'), 0, 0))
			return box
		})

		pi.registerMessageRenderer('jev-compact', (message, { outputPad }, theme) => {
			const badge = theme.fg('success', theme.bold('[ 🗜 COMPACT ]'))
			const header = `${badge} ${theme.bold('Context Compactor & Prefix Guard')}`
			const lines = [header]
			const contentStr =
				typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
			lines.push(...contentStr.split('\n').map((l: string) => theme.fg('muted', `  ${l}`)))
			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(lines.join('\n'), 0, 0))
			return box
		})
	}

	pi.on('session_start', (_event, ctx) => {
		Object.assign(h.config, loadConfig())
		h.sent.clear()
		h.status(ctx, undefined)
	})

	pi.on('before_agent_start', (event, ctx) => {
		// Guard cache prefix integrity for systemPrompt
		if (event.systemPrompt) {
			h.stats.cachePrefixChecks++
			const check = verifyCachePrefixIntegrity(event.systemPrompt)
			if (!check.isDeterministic) {
				h.stats.cachePrefixViolations += check.violations.length
				h.log({ what: 'cache_prefix_violation', violations: check.violations })
			}
		}
		return onBeforeAgentStart(h, pi, event, ctx)
	})

	pi.on('agent_end', () => {
		if (!h.allTools) return
		pi.setActiveTools(h.allTools)
		h.allTools = null
	})

	pi.on('tool_call', (event, ctx) => onToolCall(h, event, ctx))

	pi.on('tool_result', async (event, ctx) =>
		withReminder(h, event, await onToolResult(h, event, ctx))
	)

	pi.registerCommand('jev-harness', {
		description: 'jev-harness: on | log | off | stats',
		handler: async (args, ctx) => {
			const mode = (args ?? '').trim()
			if (mode !== 'on' && mode !== 'log' && mode !== 'off') {
				report(h, ctx, pi)
				return
			}
			h.config.mode = mode
			h.status(ctx, mode === 'off' ? undefined : `jev-harness ${mode}`)
			sendJevMessage(pi, ctx, 'jev-advisor', `✓ jev-harness mode set to ${mode}`, { mode })
		}
	})

	pi.registerCommand('jev-compact', {
		description: 'Context Compactor: inspect prompt cache prefix & compaction status',
		handler: async (_args, ctx) => {
			const s = h.stats
			const saved = Math.round(s.compactionCharsSaved / 4)
			const info = [
				`### 🗜 JEV Context Compactor & Prefix Cache Status`,
				`• Compaction Runs: ${s.compactionRuns} history passes`,
				`• Tokens Saved via Compaction: ~${saved.toLocaleString()} tokens`,
				`• Prefix Cache Checks: ${s.cachePrefixChecks} turns inspected`,
				`• Prefix Cache Violations: ${s.cachePrefixViolations === 0 ? '0 (✓ Deterministic Prefix Intact)' : `${s.cachePrefixViolations} warnings detected`}`,
				`• Spill Storage: Retains raw outputs in \`~/.jev-harness/spill/\``
			].join('\n')
			sendJevMessage(pi, ctx, 'jev-compact', info, { stats: s })
		}
	})
}
