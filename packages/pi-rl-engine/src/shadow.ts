import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RewardResult } from './types.ts'
import { computeReward } from './verifier.ts'

export class ShadowWorktreeManager {
	private repoRoot: string

	constructor(repoRoot: string) {
		this.repoRoot = repoRoot
	}

	/**
	 * Create a disposable detached git worktree in /tmp.
	 */
	createShadowWorktree(): string {
		const id = randomBytes(4).toString('hex')
		const shadowPath = join(tmpdir(), `pi-shadow-${Date.now()}-${id}`)

		execSync(`git worktree add --detach "${shadowPath}" HEAD`, {
			cwd: this.repoRoot,
			stdio: 'pipe',
			encoding: 'utf8'
		})

		return shadowPath
	}

	/**
	 * Remove a shadow worktree cleanly.
	 */
	cleanupShadowWorktree(shadowPath: string): void {
		try {
			execSync(`git worktree remove --force "${shadowPath}"`, {
				cwd: this.repoRoot,
				stdio: 'ignore'
			})
		} catch {
			// Fallback direct directory delete if git worktree cleanup encounters an issue
			if (existsSync(shadowPath)) {
				rmSync(shadowPath, { recursive: true, force: true })
			}
		}
	}

	/**
	 * Evaluate a rollout in a shadow worktree and return its diff patch and reward score.
	 */
	evaluateRollout(
		shadowPath: string,
		options?: { testCommand?: string; timeoutMs?: number }
	): { reward: RewardResult; patch: string } {
		const reward = computeReward(shadowPath, options)
		let patch = ''
		try {
			patch = execSync('git diff HEAD', {
				cwd: shadowPath,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore']
			})
		} catch {
			patch = ''
		}

		return { reward, patch }
	}

	/**
	 * Apply a winning patch back to the main workspace.
	 */
	applyPatchToMain(patch: string): boolean {
		if (!patch.trim()) return false
		try {
			execSync('git apply --whitespace=nowarn', {
				cwd: this.repoRoot,
				input: patch,
				stdio: ['pipe', 'pipe', 'pipe']
			})
			return true
		} catch {
			return false
		}
	}
}
