import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { ContextualBandit } from './bandit.ts'
import { ShadowWorktreeManager } from './shadow.ts'
import type { RLConfig, RLStats } from './types.ts'
import { computeReward } from './verifier.ts'

const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'rl-config.json')
const LOG_DIR = join(homedir(), '.pi-rl')

const DEFAULT_CONFIG: RLConfig = {
	mode: 'on',
	autoVerifyOnEdit: false,
	shadowBranchFactor: 2,
	testTimeoutMs: 30000,
	explorationRate: 0.1,
	rewardWeights: {
		test: 1.0,
		lint: 0.3,
		cost: 0.1
	}
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

export function registerRLExtension(pi: ExtensionAPI): void {
	const config = loadConfig()
	const bandit = new ContextualBandit()
	const stats: RLStats = {
		verifications: 0,
		passedVerifications: 0,
		failedVerifications: 0,
		shadowRollouts: 0,
		rolloutWins: 0,
		totalRewardAccumulated: 0
	}

	let currentTaskType = 'general'
	let currentModel = 'openai-codex/gpt-5.6-luna'
	let currentThinking = 'high'

	pi.on('session_start', (_event, ctx) => {
		Object.assign(config, loadConfig())
		bandit.load()
		if (ctx.hasUI && config.mode !== 'off') {
			ctx.ui.setStatus('pi-rl', `RL: ${config.mode}`)
		}
	})

	pi.on('before_agent_start', (event, ctx) => {
		if (config.mode === 'off') return

		const prompt = event.prompt.toLowerCase()
		if (prompt.includes('test') || prompt.includes('ut') || prompt.includes('spec')) {
			currentTaskType = 'test'
		} else if (prompt.includes('fix') || prompt.includes('bug') || prompt.includes('error')) {
			currentTaskType = 'fix'
		} else if (
			prompt.includes('refactor') ||
			prompt.includes('clean') ||
			prompt.includes('tối ưu')
		) {
			currentTaskType = 'refactor'
		} else {
			currentTaskType = 'general'
		}

		if (ctx.hasUI) {
			ctx.ui.setStatus('pi-rl', `RL: ${config.mode} [${currentTaskType}]`)
		}
	})

	pi.on('agent_end', (_event, ctx) => {
		if (config.mode === 'off' || config.mode === 'passive') return

		const cwd = ctx.cwd
		const result = computeReward(cwd, {
			testCommand: config.testCommand,
			timeoutMs: config.testTimeoutMs,
			weights: config.rewardWeights
		})

		stats.verifications++
		stats.totalRewardAccumulated += result.totalReward
		if (result.passed) {
			stats.passedVerifications++
		} else {
			stats.failedVerifications++
		}

		bandit.update(currentTaskType, currentModel, currentThinking, result.totalReward)

		logRL({
			event: 'turn_eval',
			taskType: currentTaskType,
			reward: result.totalReward,
			passed: result.passed,
			details: result.details
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
				`Verifications: ${stats.verifications} (Passed: ${stats.passedVerifications}, Failed: ${stats.failedVerifications})`,
				`Avg Reward: ${avgReward}`,
				`Shadow Rollouts: ${stats.shadowRollouts} (Wins: ${stats.rolloutWins})`,
				`Q-Table Highlights:`,
				qSummary || '  (no Q-table trials recorded yet)'
			].join('\n')

			ctx.ui.notify(report, 'info')
		}
	})

	pi.registerCommand('rl-verify', {
		description: 'Run ground-truth test verifier and compute immediate reward',
		handler: async (_args, ctx) => {
			const res = computeReward(ctx.cwd, {
				testCommand: config.testCommand,
				timeoutMs: config.testTimeoutMs,
				weights: config.rewardWeights
			})

			ctx.ui.notify(
				`RL Verification:\nReward: ${res.totalReward} (Passed: ${res.passed})\nCommand: ${res.details.test?.command ?? 'none'}\nLatency: ${res.details.latencyMs}ms`,
				res.passed ? 'info' : 'warning'
			)
		}
	})

	pi.registerCommand('rl-explore', {
		description: 'Run speculative shadow worktree rollout for isolated verification',
		handler: async (_args, ctx) => {
			const manager = new ShadowWorktreeManager(ctx.cwd)
			ctx.ui.notify('Creating isolated shadow worktree in /tmp...', 'info')
			let shadowPath = ''
			try {
				shadowPath = manager.createShadowWorktree()
				stats.shadowRollouts++
				const evalResult = manager.evaluateRollout(shadowPath, {
					testCommand: config.testCommand,
					timeoutMs: config.testTimeoutMs
				})

				ctx.ui.notify(
					`Shadow rollout verified: Reward=${evalResult.reward.totalReward} (Passed=${evalResult.reward.passed})`,
					evalResult.reward.passed ? 'info' : 'warning'
				)
			} catch (err: unknown) {
				ctx.ui.notify(`Shadow rollout error: ${String(err)}`, 'error')
			} finally {
				if (shadowPath) {
					manager.cleanupShadowWorktree(shadowPath)
				}
			}
		}
	})
}
