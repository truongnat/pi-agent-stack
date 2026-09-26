/**
 * advisor.ts: Dual-System System 1 Active Steering Advisor for Pi Harness.
 *
 * Provides ultra-fast pre-turn strategic briefings:
 * 1. Task classification (feature, bugfix, refactor, research, verification)
 * 2. Verification targeting (npm test, typecheck, build, diff)
 * 3. Skill & engineering practice guidance (TDD, type safety, read-first)
 * 4. Architectural invariant awareness & focused file targeting
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { advisorQuestions, choiceOf, noulOf } from './jev.ts'
import { scanRepoMap } from './repomap.ts'
import { active, type Harness } from './types.ts'

export type AdvisorBriefingResult = {
	category: string
	verification: string
	guidance: string
	invariantsScore: number
	focusPaths: string[]
	repoMap?: string | null
	briefingText: string
	summaryNote: string
}

export function detectProjectVerificationTarget(cwd: string): string {
	// 1. Rust Cargo
	if (existsSync(join(cwd, 'Cargo.toml'))) {
		return 'cargo test'
	}

	// 2. Go
	if (existsSync(join(cwd, 'go.mod'))) {
		return 'go test ./...'
	}

	// 3. Python (pytest)
	if (
		existsSync(join(cwd, 'pytest.ini')) ||
		existsSync(join(cwd, 'pyproject.toml')) ||
		existsSync(join(cwd, 'tests'))
	) {
		return 'pytest'
	}

	// 4. JS/TS (always bun per user global rules)
	const pkgPath = join(cwd, 'package.json')
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
			if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
				return 'bun test'
			}
			if (pkg.scripts?.typecheck) {
				return 'bun run typecheck'
			}
			if (pkg.scripts?.build) {
				return 'bun run build'
			}
		} catch {
			// Ignore file read errors
		}
		return 'bun test'
	}

	// 5. Makefile
	const makefile = join(cwd, 'Makefile')
	if (existsSync(makefile)) {
		try {
			if (/^test\s*:/m.test(readFileSync(makefile, 'utf8'))) {
				return 'make test'
			}
		} catch {
			// Ignore file read errors
		}
	}

	return 'diff_review'
}

/**
 * Fast offline heuristic advisor for when JEV API is offline or unconfigured.
 * Evaluates prompt keywords, repo configs, and file patterns in < 2ms.
 */
export function evaluateOfflineAdvisor(
	prompt: string,
	cwd: string,
	candidatePaths: string[] = []
): AdvisorBriefingResult {
	// 1. Detect Category
	let category = 'feature'
	if (/\b(fix|bug|error|failing|broken|issue|regression|crash|exception)\b/i.test(prompt)) {
		category = 'bugfix'
	} else if (
		/\b(refactor|clean|cleanup|reorganize|restructure|optimize|simplify)\b/i.test(prompt)
	) {
		category = 'refactor'
	} else if (/\b(how|what|explain|where|find|search|research|why|show me|list)\b/i.test(prompt)) {
		category = 'research'
	} else if (/\b(test|lint|check|typecheck|audit|verify|build|ci)\b/i.test(prompt)) {
		category = 'verification'
	}

	// 2. Detect Verification Target
	let verification = 'diff_review'
	const detectedTestCmd = detectProjectVerificationTarget(cwd)

	if (category === 'research') {
		verification = 'none'
	} else if (category === 'bugfix' || category === 'feature' || category === 'verification') {
		verification = detectedTestCmd || 'diff_review'
	}

	// 3. Engineering Guidance
	let guidance = 'minimal_diff'
	if (category === 'bugfix') {
		if (/\b(test|spec|tdd|reproduce|failing test)\b/i.test(prompt)) {
			guidance = 'tdd_first'
		} else {
			guidance = 'root_cause_first'
		}
	} else if (/\b(type|schema|interface|contract)\b/i.test(prompt)) {
		guidance = 'type_safety'
	} else if (category === 'feature') {
		guidance = 'read_first'
	}

	const focusPaths = candidatePaths.slice(0, 3)
	const invariantsScore = category === 'refactor' || category === 'bugfix' ? 0.7 : 0.3
	const repoMap = scanRepoMap(cwd)

	const briefingText = formatAdvisorBriefingText({
		category,
		verification,
		guidance,
		invariantsScore,
		focusPaths,
		repoMap
	})

	const summaryNote =
		verification && verification !== 'none'
			? `adv:${category} · ${guidance.replace(/_/g, ' ')} · ${verification}`
			: `adv:${category} · ${guidance.replace(/_/g, ' ')}`

	return {
		category,
		verification,
		guidance,
		invariantsScore,
		focusPaths,
		repoMap,
		briefingText,
		summaryNote
	}
}

/**
 * Format the synthesized Briefing Markdown to steer the System 2 model.
 */
export function formatAdvisorBriefingText(params: {
	category: string
	verification: string
	guidance: string
	invariantsScore: number
	focusPaths: string[]
	repoMap?: string | null
}): string {
	const categoryLabels: Record<string, string> = {
		bugfix: 'Bugfix / Regression Resolution',
		feature: 'Feature Implementation',
		refactor: 'Codebase Refactoring / Cleanup',
		research: 'Codebase Research & Query',
		verification: 'Verification & Quality Audit'
	}

	const guidanceLabels: Record<string, string> = {
		root_cause_first:
			'Root-cause triaging: Identify target surface & inspect error logs/trace first before speculative changes',
		tdd_first: 'TDD: Reproduce/verify with failing test first before modifying implementation',
		type_safety: 'Strict typing: Adhere strictly to TypeScript/language interfaces and contracts',
		minimal_diff: 'Minimal diff: Preserve existing styles, comments, and structure',
		read_first: 'Read before write: Locate and inspect existing patterns before creating files',
		standard: 'Standard concise coding'
	}

	const verificationLabels: Record<string, string> = {
		unit_test: 'Run test suite (e.g. bun test, cargo test) before concluding turn',
		type_check: 'Run static type check (e.g. bun run typecheck) before concluding turn',
		build: 'Run build command (e.g. bun run build, cargo build) before concluding turn',
		diff_review: 'Inspect git diff to ensure clean, focused changes',
		none: 'No test verification needed (informational query)'
	}

	const lines = ['[Harness Advisor Briefing]']
	if (params.repoMap) {
		lines.push(`• Monorepo Map: ${params.repoMap}`)
	}
	lines.push(`• Objective: ${categoryLabels[params.category] ?? params.category}`)
	const targetDesc =
		verificationLabels[params.verification] ??
		`Run \`${params.verification}\` before concluding turn`
	lines.push(`• Verification Target: ${targetDesc}`)
	lines.push(`• Engineering Guidance: ${guidanceLabels[params.guidance] ?? params.guidance}`)

	if (params.focusPaths.length > 0) {
		lines.push(`• Relevant Files: ${params.focusPaths.join(', ')}`)
	}

	if (params.invariantsScore >= 0.6) {
		lines.push(
			'• Caution: High architectural invariant sensitivity; check existing tests & conventions.'
		)
	}

	try {
		const personaBridge = (globalThis as any).piAgentStackPersona
		if (personaBridge?.getPersonaPrompt) {
			const personaText = personaBridge.getPersonaPrompt(params.category)
			if (personaText) {
				const cleaned = personaText.replace('[Developer Persona & Taste Constraints]\n', '').trim()
				lines.push(`• Persona Habits: ${cleaned}`)
			}
		}
	} catch {
		// Ignore persona lookup failure
	}

	try {
		const orchestratorBridge = (globalThis as any).piAgentStackOrchestrator
		if (orchestratorBridge?.isReady && orchestratorBridge.isReady()) {
			const providers = orchestratorBridge.getProviders()
			lines.push(
				`• Multi-Agent Dispatch: Available (${providers.length} ready providers: ${providers.join(', ')}). Use invoke_subagent for parallel search, debugging, or sub-tasks.`
			)
		}
	} catch {
		// Ignore orchestrator lookup failure
	}

	return lines.join('\n')
}

/**
 * Main Advisor generator: runs fast JEV System 1 question or falls back to heuristic.
 */
export async function generateAdvisorBriefing(
	h: Harness,
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	candidatePaths: string[] = []
): Promise<AdvisorBriefingResult | null> {
	if (h.config.advisor === false) return null

	// 1. If JEV is active, use System 1 inference
	if (active(h)) {
		try {
			const result = await h.jev(
				'advisor',
				{
					task: prompt,
					cwd: ctx.cwd,
					candidateFiles: candidatePaths.slice(0, 5)
				},
				advisorQuestions,
				ctx
			)

			if (result?.answers) {
				const category = choiceOf(result.answers, 'category').choice
				const verification = choiceOf(result.answers, 'verification').choice
				const guidance = choiceOf(result.answers, 'skill_guidance').choice
				const invariantsScore = noulOf(result.answers, 'invariants')
				const focusPaths = candidatePaths.slice(0, 3)
				const repoMap = scanRepoMap(ctx.cwd)

				const briefingText = formatAdvisorBriefingText({
					category,
					verification,
					guidance,
					invariantsScore,
					focusPaths,
					repoMap
				})

				const summaryNote =
					verification && verification !== 'none'
						? `adv:${category} · ${guidance.replace(/_/g, ' ')} · ${verification}`
						: `adv:${category} · ${guidance.replace(/_/g, ' ')}`

				h.stats.advisorBriefings++

				return {
					category,
					verification,
					guidance,
					invariantsScore,
					focusPaths,
					repoMap,
					briefingText,
					summaryNote
				}
			}
		} catch (err) {
			h.log({ what: 'advisor_error', error: err instanceof Error ? err.message : String(err) })
		}
	}

	// 2. Offline / Fast Heuristic Fallback
	const offlineResult = evaluateOfflineAdvisor(prompt, ctx.cwd, candidatePaths)
	h.stats.advisorBriefings++
	return offlineResult
}
