import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { ContextualBandit } from './bandit.ts'
import { LessonStore } from './lessons.ts'
import { synthesizeLessonFromTrajectory } from './reflection.ts'
import type { RLConfig, RLStats } from './types.ts'
import { computeRewardAsync } from './verifier.ts'

const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'rl-config.json')
const LOG_DIR = join(homedir(), '.pi-rl')
const MAX_WORKSPACE_DIFF_BYTES = 32 * 1024 * 1024

const DEFAULT_CONFIG: RLConfig = {
	mode: 'on',
	autoVerifyOnEdit: true,
	testTimeoutMs: 30000,
	rewardWeights: {
		test: 1.0,
		lint: 0.3,
		cost: 0.1
	}
}

function workspaceFingerprint(cwd: string): string | undefined {
	try {
		const hash = createHash('sha256')
		hash.update(
			execFileSync('git', ['diff', 'HEAD', '--binary'], {
				cwd,
				// git errors (not a repo, no commits yet) must not spill into the TUI.
				stdio: ['ignore', 'pipe', 'ignore'],
				maxBuffer: MAX_WORKSPACE_DIFF_BYTES
			})
		)
		const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
			cwd,
			// git errors (not a repo, no commits yet) must not spill into the TUI.
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8'
		})
		for (const relativePath of untracked.split('\0').filter(Boolean)) {
			try {
				const stat = readFileSync(join(cwd, relativePath), { flag: 'r' })
				hash.update(relativePath)
				hash.update(stat)
			} catch {
				hash.update(`${relativePath}:unreadable`)
			}
		}
		return hash.digest('hex')
	} catch {
		return undefined
	}
}

function getChangedFiles(cwd: string): string[] {
	try {
		const diffFiles = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
			cwd,
			// git errors (not a repo, no commits yet) must not spill into the TUI.
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8'
		})
			.split('\n')
			.filter(Boolean)
		const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
			cwd,
			// git errors (not a repo, no commits yet) must not spill into the TUI.
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8'
		})
			.split('\n')
			.filter(Boolean)
		return Array.from(new Set([...diffFiles, ...untracked]))
	} catch {
		return []
	}
}

function taskTypeForPrompt(prompt: string): string {
	const normalized = prompt.toLowerCase()
	if (/\b(test|tests|testing|spec|specs)\b|unit test/.test(normalized)) {
		return 'test'
	}
	if (/\b(fix|bug|error)\b|lỗi|sửa/.test(normalized)) {
		return 'fix'
	}
	if (/\b(refactor|clean|optimize|optimise)\b/.test(normalized) || normalized.includes('tối ưu')) {
		return 'refactor'
	}
	return 'general'
}

function loadConfig(): RLConfig {
	if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG }
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<RLConfig>
		return { ...DEFAULT_CONFIG, ...raw }
	} catch {
		return { ...DEFAULT_CONFIG }
	}
}

function saveConfig(cfg: RLConfig): void {
	try {
		mkdirSync(join(homedir(), '.pi', 'agent'), { recursive: true })
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
	} catch {
		// ignore write error
	}
}

function logRL(event: Record<string, unknown>): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true })
		appendFileSync(
			join(LOG_DIR, 'rl-events.jsonl'),
			`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
		)
	} catch {
		// ignore logging error
	}
}

function recordVerification(
	result: Awaited<ReturnType<typeof computeRewardAsync>>,
	stats: RLStats,
	bandit: ContextualBandit,
	taskType: string,
	model: { provider: string; id: string } | undefined,
	thinking: string
): void {
	if (result.status === 'skipped') {
		stats.skippedVerifications++
		logRL({ event: 'verification_skipped', reason: result.details.test?.reason ?? 'inconclusive' })
		return
	}

	stats.verifications++
	stats.totalRewardAccumulated += result.totalReward
	if (result.passed) stats.passedVerifications++
	else stats.failedVerifications++
	if (model) {
		bandit.update(taskType, `${model.provider}/${model.id}`, thinking, result.totalReward)
	}
	logRL({
		event: 'turn_eval',
		taskType,
		reward: result.totalReward,
		passed: result.passed,
		model: model ? `${model.provider}/${model.id}` : undefined,
		thinking,
		details: result.details
	})
}

export function registerRLExtension(pi: ExtensionAPI): void {
	const config = loadConfig()
	const bandit = new ContextualBandit()
	const lessonStore = new LessonStore()
	const stats: RLStats = {
		verifications: 0,
		skippedVerifications: 0,
		passedVerifications: 0,
		failedVerifications: 0,
		totalRewardAccumulated: 0
	}

	let currentTaskType = 'general'
	let currentPrompt = ''
	let taskStartFingerprint: string | undefined

	pi.on('session_start', (_event, ctx) => {
		Object.assign(config, loadConfig())
		bandit.load()
		if (ctx.hasUI && config.mode !== 'off') {
			ctx.ui.setStatus('pi-rl', `RL: ${config.mode}`)
		}
	})

	pi.on('before_agent_start', (event, ctx) => {
		currentPrompt = event.prompt
		if (config.mode === 'off') return
		taskStartFingerprint = workspaceFingerprint(ctx.cwd)
		currentTaskType = taskTypeForPrompt(event.prompt)

		if (ctx.hasUI) {
			ctx.ui.setStatus('pi-rl', `RL: ${config.mode} [${currentTaskType}]`)
		}

		// Semantic RL: Find and inject relevant learned lessons for this codebase
		const repoName = lessonStore.sanitizeRepoName(ctx.cwd)
		const relevantLessons = lessonStore.findRelevantLessons(event.prompt, repoName, 3)

		if (relevantLessons.length > 0) {
			const lessonContext = lessonStore.formatLessonsForPrompt(relevantLessons)
			const basePrompt = event.systemPrompt || ''
			return {
				systemPrompt: basePrompt ? `${basePrompt}\n\n${lessonContext}` : lessonContext
			}
		}

		return undefined
	})

	pi.on('agent_end', (_event, ctx) => {
		if (config.mode === 'off' || config.mode === 'passive') return
		const currentFingerprint = workspaceFingerprint(ctx.cwd)
		if (
			!config.autoVerifyOnEdit ||
			!taskStartFingerprint ||
			!currentFingerprint ||
			taskStartFingerprint === currentFingerprint
		) {
			return
		}
		taskStartFingerprint = currentFingerprint

		const verificationOptions = {
			testCommand: config.testCommand,
			timeoutMs: config.testTimeoutMs,
			weights: config.rewardWeights
		}
		const currentModel = ctx.model
		const thinking = pi.getThinkingLevel()
		const changedFiles = getChangedFiles(ctx.cwd)
		const repoName = lessonStore.sanitizeRepoName(ctx.cwd)

		void computeRewardAsync(ctx.cwd, verificationOptions)
			.then((result) => {
				recordVerification(result, stats, bandit, currentTaskType, currentModel, thinking)

				// Semantic RL: Synthesize and record lesson on passed verification with changes
				if (result.passed && changedFiles.length > 0) {
					const lesson = synthesizeLessonFromTrajectory({
						taskType: currentTaskType,
						prompt: currentPrompt,
						repo: repoName,
						modifiedFiles: changedFiles,
						verificationPassed: true,
						testOutput: result.details.test?.output
					})
					lessonStore.saveLesson(lesson)
					logRL({
						event: 'lesson_synthesized',
						lessonId: lesson.id,
						repo: repoName,
						taskSummary: lesson.taskSummary,
						ruleLearned: lesson.ruleLearned
					})
				}
			})
			.catch((error: unknown) => {
				logRL({
					event: 'verification_error',
					error: error instanceof Error ? error.message : String(error)
				})
			})
	})

	// 1. Command: /rl
	pi.registerCommand('rl', {
		description: 'RL Engine controls: /rl [on|off|passive|stats]',
		handler: async (args, ctx) => {
			const sub = (args ?? '').trim().toLowerCase()
			if (sub === 'on' || sub === 'off' || sub === 'passive') {
				config.mode = sub
				saveConfig(config)
				if (ctx.hasUI) {
					ctx.ui.setStatus('pi-rl', sub === 'off' ? undefined : `RL: ${sub}`)
					ctx.ui.notify(`pi-rl mode set to ${sub}`, 'info')
				}
				return
			}

			// Display stats
			const avgReward = stats.verifications
				? (stats.totalRewardAccumulated / stats.verifications).toFixed(2)
				: '0.00'
			const qEntries = bandit.getAllEntries().slice(0, 5)
			const qSummary = qEntries
				.map(
					(q) =>
						`  • [${q.taskType}] ${q.model} (${q.thinkingLevel}): Q=${q.qValue.toFixed(2)} (${q.successes}/${q.trials})`
				)
				.join('\n')

			const repoName = lessonStore.sanitizeRepoName(ctx.cwd)
			const lessonCount = lessonStore.getLessons(repoName).length

			const report = [
				`=== Pi RL Engine (${config.mode}) ===`,
				`Verifications: ${stats.verifications} (Passed: ${stats.passedVerifications}, Failed: ${stats.failedVerifications}, Skipped: ${stats.skippedVerifications})`,
				`Avg Reward: ${avgReward}`,
				`Learned Lessons for "${repoName}": ${lessonCount} lesson(s) stored`,
				`Q-Table Highlights:`,
				qSummary || '  (no Q-table trials recorded yet)'
			].join('\n')

			ctx.ui.notify(report, 'info')
		}
	})

	// 2. Command: /lessons
	pi.registerCommand('lessons', {
		description: 'Manage learned lessons & episodic reflections: /lessons [list|search <query>|summary]',
		handler: async (args, ctx) => {
			const input = (args ?? '').trim()
			const repoName = lessonStore.sanitizeRepoName(ctx.cwd)
			const lessons = lessonStore.getLessons(repoName)

			if (input.startsWith('search ')) {
				const query = input.replace('search ', '').trim()
				const matched = lessonStore.findRelevantLessons(query, repoName, 5)
				if (matched.length === 0) {
					ctx.ui.notify(`No lessons found matching query: "${query}"`, 'warning')
					return
				}
				const lines = matched.map(
					(l) => `• **${l.taskSummary}**\n  - *Rule*: ${l.ruleLearned}\n  - *Tags*: [${(l.tags || []).join(', ')}]`
				)
				ctx.ui.notify(`### Matched Lessons for "${query}":\n\n${lines.join('\n\n')}`, 'info')
				return
			}

			if (input === 'summary') {
				const summaryPath = lessonStore.getRepoSummaryPath(repoName)
				ctx.ui.notify(`Lesson summary report: ${summaryPath}`, 'info')
				return
			}

			if (lessons.length === 0) {
				ctx.ui.notify(
					`No lessons recorded yet for "${repoName}". Lessons are automatically learned when code edits pass verification tests, or via /reflect <note>.`,
					'info'
				)
				return
			}

			const items = lessons
				.slice(-10)
				.reverse()
				.map((l) => `• \`${l.id}\` **${l.taskSummary}**\n  💡 *${l.ruleLearned}*`)
				.join('\n\n')

			ctx.ui.notify(
				`### 📚 Learned Lessons for "${repoName}" (Total: ${lessons.length})\n\n${items}\n\n*Use \`/lessons search <term>\` or check \`${lessonStore.getRepoSummaryPath(repoName)}\`*`,
				'info'
			)
		}
	})

	// 3. Command: /reflect
	pi.registerCommand('reflect', {
		description: 'Explicitly record a lesson or rule learned for this repository: /reflect <lesson/note>',
		handler: async (args, ctx) => {
			const note = (args ?? '').trim()
			if (!note) {
				ctx.ui.notify('Usage: /reflect <lesson or rule learned from this session>', 'warning')
				return
			}

			const repoName = lessonStore.sanitizeRepoName(ctx.cwd)
			const changedFiles = getChangedFiles(ctx.cwd)
			const lesson = synthesizeLessonFromTrajectory({
				taskType: currentTaskType,
				prompt: currentPrompt || note,
				repo: repoName,
				modifiedFiles: changedFiles,
				verificationPassed: true,
				customNote: note
			})

			lessonStore.saveLesson(lesson)
			ctx.ui.notify(
				`✓ Saved lesson \`${lesson.id}\` to "${repoName}" knowledge store:\n"${note}"`,
				'info'
			)
		}
	})

	pi.registerCommand('rl-verify', {
		description: 'Run ground-truth test verifier and compute immediate reward',
		handler: async (_args, ctx) => {
			const res = await computeRewardAsync(ctx.cwd, {
				testCommand: config.testCommand,
				timeoutMs: config.testTimeoutMs,
				weights: config.rewardWeights
			})

			const outcome =
				res.status === 'skipped'
					? `Skipped: ${res.details.test?.reason ?? 'not verifiable'}`
					: `Reward: ${res.totalReward} (Passed: ${res.passed})`
			ctx.ui.notify(
				`RL Verification:\n${outcome}\nCommand: ${res.details.test?.command || 'none'}\nLatency: ${res.details.latencyMs ?? 0}ms`,
				res.status === 'failed' ? 'warning' : 'info'
			)
		}
	})
}
