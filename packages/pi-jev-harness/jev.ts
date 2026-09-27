// Minimal TypeSafe System One client. Plain fetch, no dependencies.
// Every question this extension asks is defined here so the whole policy is reviewable in one file.

export type Question =
	| { type: 'noul'; instructions: string }
	| { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
	| { type: 'score'; instructions: string; criteria: string[] }

export type Answer =
	| { type: 'noul'; noul: number }
	| { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
	| { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> }

export type Answers = Record<string, Answer>

export type BillingMode = 'api' | 'subscription' | 'unknown'

export type RoutingModel = {
	key: string
	provider: string
	label: string
	inputCost: number
	outputCost: number
	contextWindow: number
	billingMode: BillingMode
	readiness: boolean
	quotaAvailable?: boolean | undefined
	latencyEstimateMs: number
	marginalInputCost: number
	marginalOutputCost: number
	toolMode?: 'native' | 'compatibility' | undefined
	history?: { trials: number; successRate: number; qValue: number } | undefined
}

export type Result = { answers: Answers; inputTokens: number; ms: number }

type ApiResponse = { answers: Answers; usage: { input_tokens: number } }

export type AskOptions = {
	timeoutMs?: number | undefined
	signal?: AbortSignal | undefined
	apiKey?: string | undefined
}

export async function ask(
	state: unknown,
	questions: Record<string, Question>,
	options: AskOptions = {}
): Promise<Result> {
	const apiKey = options.apiKey ?? process.env.JEV_API_KEY
	if (!apiKey) throw new Error('JEV_API_KEY is not set')
	const started = performance.now()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000)
	options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
	try {
		const response = await fetch('https://api.typesafe.ai/v1/systemone', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: 'jev-latest', state, questions }),
			signal: controller.signal
		})
		if (!response.ok) {
			throw new Error(`TypeSafe API ${response.status}: ${(await response.text()).slice(0, 200)}`)
		}
		// SAFETY: the documented System One response shape; the accessors below throw on any mismatch.
		const { answers, usage } = (await response.json()) as ApiResponse
		return { answers, inputTokens: usage.input_tokens, ms: Math.round(performance.now() - started) }
	} finally {
		clearTimeout(timer)
	}
}

export const noul = (instructions: string): Question => ({ type: 'noul', instructions })

export const choice = (
	instructions: string,
	criteria: Record<string, string | null>
): Question => ({
	type: 'choice',
	instructions,
	criteria
})

export const score = (instructions: string, criteria: string[]): Question => ({
	type: 'score',
	instructions,
	criteria
})

/** Typed readers. A missing or wrongly typed answer is a contract break, so they throw. */
export function noulOf(answers: Answers, key: string): number {
	const a = answers[key]
	if (a?.type !== 'noul') throw new Error(`expected a noul answer for ${key}`)
	return a.noul
}

export function choiceOf(answers: Answers, key: string): { choice: string; confidence: number } {
	const a = answers[key]
	if (a?.type !== 'choice') throw new Error(`expected a choice answer for ${key}`)
	return { choice: a.choice, confidence: a.confidence }
}

export function scoreOf(answers: Answers, key: string): { score: number; confidence: number } {
	const a = answers[key]
	if (a?.type !== 'score') throw new Error(`expected a score answer for ${key}`)
	return { score: a.score, confidence: a.confidence }
}

// ---- 1. routing: what kind of turn is it, and which tools will it need ----
export const KINDS: Record<string, string> = {
	answer:
		'A question or request the model can answer from what it already knows or from the conversation, with no tool use',
	explore:
		'The model has to find, read, or search code or files to answer or to understand something',
	change: 'The model has to create or edit files, then probably verify',
	run: 'The model has to run a command, script, test, build, or git operation as the main action',
	unclear: 'Too vague or ambiguous to act on; the model should ask one question first'
}

export function routingQuestions(
	toolNames: string[],
	models: RoutingModel[] = [],
	modelRouting = false
): Record<string, Question> {
	const questions: Record<string, Question> = {
		kind: choice("What kind of turn is the user's `prompt` asking for?", KINDS)
	}
	for (const name of toolNames) {
		questions[`use_${name}`] = noul(
			`Will the \`${name}\` tool likely be needed at some point while doing what \`prompt\` asks? Consider the tool's description in \`tools\`.`
		)
	}
	if (modelRouting) {
		questions.model = choice(
			'Choose the cheapest sufficient model for `task`. Prefer `keep_current` unless a cheaper candidate is clearly sufficient. Never choose a more expensive model automatically. Use verified history only as a tie-breaker among candidates within 5% of the same marginal cost, and only when history has at least 3 trials. Never pay more because of a historical score. HARD RULE: never choose a candidate with tools=compatibility when `kind` is explore, change, run, or unclear — those turns need native Pi tools; only answer turns may use subscription/compatibility providers. Prefer ready subscription candidates (billingMode=subscription, readiness=true, quotaAvailable) only for answer turns when latency is acceptable. Skip unavailable or quota-exhausted providers. API providers remain valid fallbacks.',
			{
				keep_current: 'Keep the current model to preserve prompt-cache continuity',
				...Object.fromEntries(models.map((model) => [model.key, model.label]))
			}
		)
		questions.thinking = choice(
			'Choose the lowest thinking level that is sufficient for `task`. Prefer `keep_current` when uncertain.',
			{
				keep_current: 'Keep the current thinking level',
				minimal: 'Simple lookup, formatting, or one-file change',
				low: 'Small edit, focused explanation, or straightforward command',
				medium: 'Normal coding, debugging, or multi-step exploration',
				high: 'Complex reasoning, architecture, or risky multi-file change'
			}
		)
	}
	return questions
}

// ---- 2. pre-fetch: which candidate files should be read before the model starts ----
// Named files are left for the model's targeted read. Jev ranks vague-prompt candidates.
export function relevanceQuestions(paths: string[]): Record<string, Question> {
	const questions: Record<string, Question> = {
		first: choice(
			'Which file in `files` should the model read first to do `task`? Judge from the path and the matching lines.',
			Object.fromEntries(paths.map((path) => [path, null]))
		)
	}
	paths.forEach((path, i) => {
		questions[`f${i}`] = noul(
			`Will the model need to read \`${path}\` to do \`task\`? Judge from the matching lines in \`files\`, not from how many terms matched. A file that only matches common words usually is not needed.`
		)
	})
	return questions
}

// ---- 3. result judgement: what part of a tool result does the model need ----
export const resultQuestions: Record<string, Question> = {
	succeeded: noul('Did the tool call do what it was meant to do, regardless of exit code wording?'),
	relevant: noul(
		'Does the output contain information the model needs for `task`, or that changes what it should do next?'
	),
	keep: choice('How much of this output should the model see?', {
		all: 'All of it; details throughout matter',
		head: 'Only the beginning; the rest is repetition, noise, or long listings',
		drop: 'None of it; a one-line note that it ran is enough'
	})
}

// ---- 4. loop control ----
export const loopQuestions: Record<string, Question> = {
	stuck: noul(
		'Looking at `recentCalls`, is the agent repeating the same actions without making progress on `task`?'
	),
	wrong_approach: noul(
		'Would a different approach, or asking the user, be better than continuing this way?'
	)
}

// ---- 5. guard: a compact version of pi-jev-guard, asked in the same request as loop control ----
export const guardQuestions: Record<string, Question> = {
	risk: score(
		'Is this action a critical danger to the OS/machine, remote infrastructure, or credentials? (Local workspace operations, builds, file edits/deletions, git reset, and dev server lifecycle are routine level 0/1).',
		[
			'Safe local read/inspect: reading, listing, searching, git status or diff, running tests, type checks.',
			'Routine local development: editing/creating/deleting workspace files, rm/clean in workspace, git reset/rebase, process lifecycle & dev server restarts, builds, packages.',
			'Remote infrastructure & repository mutations: pushing to remote repository, SSH remote execution, modifying external network services.',
			'Critical system hazard & data loss: destructive OS commands (rm -rf / or ~), disk formatting, master credential theft (~/.ssh, ~/.aws), dropping production databases.'
		]
	),
	secrets: noul(
		'Does this call exfiltrate secrets (e.g. sending keys to remote endpoints), commit/push .env/credentials to git, or access global master keys (~/.ssh, ~/.aws, ~/.keys)? Local project .env reads for build/test are safe (0.0).'
	)
}

// ---- 6. goal evaluation: independent check whether the objective is met ----
export const goalQuestions: Record<string, Question> = {
	objective_met: noul(
		'Looking at `objective`, `lastAssistantMessage`, and `toolSummary`, is the stated goal or objective completely achieved and verified?'
	),
	reason: choice('What is the completion state of `objective`?', {
		met: 'All requirements of the objective are completely met and verified',
		partially_met: 'Progress was made but some requirements, checks, or fixes remain incomplete',
		blocked_or_stuck: 'The agent is blocked, stuck in an error loop, or failed critical checks',
		not_started: 'The objective has not been meaningfully started or addressed yet'
	})
}

// ---- 7. advisor briefing: strategic co-pilot briefing before main model generates ----
export const advisorQuestions: Record<string, Question> = {
	category: choice('What is the primary technical objective of `task`?', {
		bugfix: 'Fixing an existing bug, failing test, runtime error, or regression',
		feature: 'Implementing a new capability, tool, endpoint, or extension',
		refactor: 'Restructuring, cleaning, optimizing, or modularizing existing code',
		research: 'Explaining code, searching repository, reading documentation, or answering queries',
		verification: 'Running tests, type-checking, building, or auditing security'
	}),
	verification: choice('What is the primary verification method to confirm `task` is complete?', {
		unit_test: 'Run unit test suite (e.g., npm test, pytest, cargo test)',
		type_check: 'Run static type-checker (e.g., tsc, mypy, dart analyze)',
		build: 'Run build command (e.g., npm run build, cargo build)',
		diff_review: 'Review git diff or output inspection without automated test runner',
		none: 'Informational answer or query; no code execution verification needed'
	}),
	skill_guidance: choice('Which engineering practice is most critical for `task`?', {
		root_cause_first:
			'Root-cause triaging: Identify target surface and inspect error logs/trace first before speculative edits',
		tdd_first: 'TDD: Inspect/reproduce with failing test before changing implementation',
		type_safety: 'Strict typing: Ensure interfaces, types, and schema contracts match',
		minimal_diff: 'Minimal diff: Preserve existing structure, comments, and style conventions',
		read_first: 'Read before write: Locate and inspect existing patterns before creating files',
		standard: 'Standard concise coding'
	}),
	invariants: noul(
		'Does `task` have non-obvious traps, architectural invariants, or sensitive areas?'
	)
}

export const THRESHOLDS = {
	toolNeeded: 0.35, // keep a tool if Jev gives it at least this much
	prefetchFile: 0.55, // SWE-agent ACI: slightly easier second-file prefetch
	dropResult: 0.3, // drop a result when relevance is below this and keep says drop
	stuck: 0.7,
	secrets: 0.7,
	askConfidence: 0.5 // hard_to_reverse or destructive needs this much confidence to prompt
}

export type ThresholdConfig = Partial<{
	toolNeeded: number
	prefetchFile: number
	dropResult: number
	stuck: number
	secrets: number
	askConfidence: number
}>

/** File-tunable academic knobs. Values outside [0, 1] are ignored. */
export function applyThresholdOverrides(over?: ThresholdConfig): void {
	if (!over) return
	for (const key of Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]) {
		const value = over[key]
		if (typeof value === 'number' && value >= 0 && value <= 1) {
			THRESHOLDS[key] = value
		}
	}
}
