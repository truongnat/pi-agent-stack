import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { ContextualBandit } from './bandit.ts'
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
				maxBuffer: MAX_WORKSPACE_DIFF_BYTES
			})
		)
		const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
			cwd,
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
	const stats: RLStats = {
		verifications: 0,
		skippedVerifications: 0,
		passedVerifications: 0,
		failedVerifications: 0,
		totalRewardAccumulated: 0
	}

	let currentTaskType = 'general'
	let taskStartFingerprint: string | undefined

	pi.on('session_start', (_event, ctx) => {
		Object.assign(config, loadConfig())
		bandit.load()
		if (ctx.hasUI && config.mode !== 'off') {
			ctx.ui.setStatus('pi-rl', `RL: ${config.mode}`)
		}
	})

	pi.on('before_agent_start', (event, ctx) => {
		if (config.mode === 'off') return
		taskStartFingerprint = workspaceFingerprint(ctx.cwd)
		currentTaskType = taskTypeForPrompt(event.prompt)

		if (ctx.hasUI) {
			ctx.ui.setStatus('pi-rl', `RL: ${config.mode} [${currentTaskType}]`)
		}
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
		void computeRewardAsync(ctx.cwd, verificationOptions)
			.then((result) =>
				recordVerification(result, stats, bandit, currentTaskType, currentModel, thinking)
			)
			.catch((error: unknown) => {
				logRL({
					event: 'verification_error',
					error: error instanceof Error ? error.message : String(error)
				})
			})
	})

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

			const report = [
				`=== Pi RL Engine (${config.mode}) ===`,
				`Verifications: ${stats.verifications} (Passed: ${stats.passedVerifications}, Failed: ${stats.failedVerifications}, Skipped: ${stats.skippedVerifications})`,
				`Avg Reward: ${avgReward}`,
				'Exploration: disabled (candidate generation is not connected)',
				`Q-Table Highlights:`,
				qSummary || '  (no Q-table trials recorded yet)'
			].join('\n')

			ctx.ui.notify(report, 'info')
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

	pi.registerCommand('rl-explore', {
		description: 'Explain reinforcement-learning exploration availability',
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				'Candidate generation is not connected, so RL exploration is disabled. JEV still chooses the model using verified history; use /rl-verify to run a manual check.',
				'warning'
			)
		}
	})
}
