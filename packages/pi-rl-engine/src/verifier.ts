import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RewardResult, RewardWeights, VerificationDetail } from './types.ts'

/**
 * Auto-detect the primary test command for a repository or directory.
 */
export function detectTestCommand(cwd: string): string | null {
	const packageJsonPath = join(cwd, 'package.json')
	if (existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
				scripts?: Record<string, string>
			}
			if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
				return 'npm test'
			}
		} catch {
			// ignore JSON error
		}
	}

	if (
		existsSync(join(cwd, 'pytest.ini')) ||
		existsSync(join(cwd, 'pyproject.toml')) ||
		existsSync(join(cwd, 'tests'))
	) {
		return 'pytest'
	}

	if (existsSync(join(cwd, 'Cargo.toml'))) {
		return 'cargo test'
	}

	if (existsSync(join(cwd, 'go.mod'))) {
		return 'go test ./...'
	}

	if (existsSync(join(cwd, 'Makefile'))) {
		return 'make test'
	}

	return null
}

/**
 * Run a command safely with timeout and return its exit code and stdout/stderr.
 */
export function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number = 30000
): { passed: boolean; exitCode: number; output: string } {
	try {
		const output = execSync(command, {
			cwd,
			timeout: timeoutMs,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		})
		return { passed: true, exitCode: 0, output: String(output) }
	} catch (err: unknown) {
		const execError = err as { status?: number; stdout?: string; stderr?: string }
		const stdout = execError.stdout ? String(execError.stdout) : ''
		const stderr = execError.stderr ? String(execError.stderr) : ''
		return {
			passed: false,
			exitCode: execError.status ?? 1,
			output: `${stdout}\n${stderr}`.trim()
		}
	}
}

/**
 * Evaluate ground-truth reward for a given workspace.
 */
export function computeReward(
	cwd: string,
	options?: {
		testCommand?: string
		timeoutMs?: number
		weights?: RewardWeights
	}
): RewardResult {
	const timeoutMs = options?.timeoutMs ?? 30000
	const weights: RewardWeights = options?.weights ?? {
		test: 1.0,
		lint: 0.3,
		cost: 0.1
	}

	const cmd = options?.testCommand || detectTestCommand(cwd)
	const details: VerificationDetail = {}
	let score = 0
	let passed = true

	const start = Date.now()

	if (cmd) {
		const res = runCommand(cmd, cwd, timeoutMs)
		details.test = {
			command: cmd,
			passed: res.passed,
			exitCode: res.exitCode,
			output: res.output.slice(-2000)
		}
		if (res.passed) {
			score += 1.0 * weights.test
		} else {
			score -= 1.0 * weights.test
			passed = false
		}
	} else {
		// No test suite found: neutral reward
		score = 0
	}

	details.latencyMs = Date.now() - start

	return {
		totalReward: Number(score.toFixed(3)),
		passed,
		details,
		at: new Date().toISOString()
	}
}
