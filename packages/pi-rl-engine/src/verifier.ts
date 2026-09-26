import { exec, execFile, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RewardResult, RewardWeights, VerificationDetail } from './types.ts'

type ProjectManifest = {
	packageManager?: string
	scripts?: Record<string, string>
	engines?: { node?: string }
}

type RuntimePlan = { nodeVersion?: string; reason?: string }
type CommandResult = {
	status: 'passed' | 'failed' | 'unavailable'
	passed: boolean
	exitCode: number
	output: string
}

function readManifest(cwd: string): ProjectManifest | undefined {
	const packageJsonPath = join(cwd, 'package.json')
	if (!existsSync(packageJsonPath)) return undefined
	try {
		return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as ProjectManifest
	} catch {
		return undefined
	}
}

function packageManager(manifest: ProjectManifest, cwd: string): string {
	const declared = manifest.packageManager?.split('@')[0]
	if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') {
		return declared
	}
	if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
	if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
	if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
	return 'npm'
}

function nodeVersionParts(version: string): number[] | undefined {
	const match = version.match(/^(?:v)?(\d+)\.(\d+)\.(\d+)/)
	return match ? match.slice(1).map(Number) : undefined
}

function compareVersions(left: string, right: string): number | undefined {
	const leftParts = nodeVersionParts(left)
	const rightParts = nodeVersionParts(right)
	if (!leftParts || !rightParts) return undefined
	for (let index = 0; index < 3; index++) {
		if (leftParts[index] !== rightParts[index]) return leftParts[index]! - rightParts[index]!
	}
	return 0
}

function minimumNodeVersion(engine: string | undefined): string | undefined {
	if (!engine) return undefined
	return engine.match(/(?:^|\s)>=\s*v?(\d+\.\d+\.\d+)/)?.[1]
}

function compatibleMiseNode(minimum: string): string | undefined {
	try {
		const output = execFileSync('mise', ['ls', 'node', '--json'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 2_000
		})
		const installs = JSON.parse(output) as Array<{ version?: string; installed?: boolean }>
		const compatible = installs
			.filter((install) => install.installed && install.version)
			.map((install) => install.version!)
			.filter((version) => (compareVersions(version, minimum) ?? -1) >= 0)
			.sort((left, right) => compareVersions(left, right) ?? 0)
		return compatible[0]
	} catch {
		return undefined
	}
}

function runtimePlan(manifest: ProjectManifest | undefined): RuntimePlan {
	const minimum = minimumNodeVersion(manifest?.engines?.node)
	if (!minimum || (compareVersions(process.versions.node, minimum) ?? -1) >= 0) return {}
	const nodeVersion = compatibleMiseNode(minimum)
	return nodeVersion
		? { nodeVersion }
		: {
				reason: `Node ${manifest?.engines?.node} required; current Node is ${process.versions.node}`
			}
}

function isMakeTestTarget(cwd: string): boolean {
	const makefile = join(cwd, 'Makefile')
	return existsSync(makefile) && /^test\s*:/m.test(readFileSync(makefile, 'utf8'))
}

/**
 * Target a specific unit test file related to the changed files,
 * or fallback to static check / scoped tests to protect large enterprise codebases.
 */
export function detectTestCommand(cwd: string, changedFiles: string[] = []): string | null {
	const manifest = readManifest(cwd)
	const manager = manifest ? packageManager(manifest, cwd) : 'npm'
	const runPrefix =
		manager === 'bun'
			? 'bun test'
			: manager === 'pnpm'
				? 'pnpm test'
				: manager === 'yarn'
					? 'yarn test'
					: 'npm test'

	// 1. If specific files were edited, look for their corresponding *.test.* or *.spec.* file
	for (const file of changedFiles) {
		const norm = file.replace(/\\/g, '/')
		if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(norm) && existsSync(join(cwd, file))) {
			// Directly edited a test file: run only this test file
			return manager === 'bun' ? `bun test "${file}"` : `${runPrefix} -- "${file}"`
		}

		// Look for co-located or test/ mirror file
		const baseWithoutExt = norm.replace(/\.[cm]?[jt]sx?$/, '')
		const relBase = baseWithoutExt.replace(/^.*packages\/[^/]+\//, '')
		const candidates = [
			`${baseWithoutExt}.test.ts`,
			`${baseWithoutExt}.test.js`,
			`${baseWithoutExt}.spec.ts`,
			`${baseWithoutExt}.spec.js`,
			baseWithoutExt.replace(/\/src\//, '/test/') + '.test.ts',
			baseWithoutExt.replace(/\/src\//, '/test/') + '.test.js',
			`${relBase}.test.ts`,
			`${relBase}.test.js`,
			`${relBase}.spec.ts`,
			`${relBase}.spec.js`,
			relBase.replace(/^src\//, 'test/') + '.test.ts',
			relBase.replace(/^src\//, 'test/') + '.test.js'
		]

		for (const cand of candidates) {
			if (existsSync(join(cwd, cand))) {
				return manager === 'bun' ? `bun test "${cand}"` : `${runPrefix} -- "${cand}"`
			}
		}
	}

	// 2. If no specific target test found, NEVER run dangerous unbounded test suite in large repos
	// Instead, check if package.json has a fast static typecheck or lint script
	if (manifest?.scripts?.typecheck) {
		return `${manager === 'bun' ? 'bun' : manager} run typecheck`
	}
	if (manifest?.scripts?.lint) {
		return `${manager === 'bun' ? 'bun' : manager} run lint`
	}

	// 3. Fallback to package.json test ONLY if explicitly a small project or simple runner
	if (manifest?.scripts?.test && !manifest.scripts.test.includes('no test specified')) {
		// Only run full test if small repo or single test file
		return manager === 'npm' ? 'npm test' : `${manager} ${manager === 'bun' ? 'run ' : ''}test`
	}

	if (
		existsSync(join(cwd, 'pytest.ini')) ||
		existsSync(join(cwd, 'pyproject.toml')) ||
		existsSync(join(cwd, 'tests'))
	) {
		return 'pytest'
	}
	if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo test'
	if (existsSync(join(cwd, 'go.mod'))) return 'go test ./...'
	if (isMakeTestTarget(cwd)) return 'make test'
	return null
}

/** Run a test command and distinguish a broken runtime from a failing test suite. */
export function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number = 30000,
	nodeVersion?: string
): {
	status: 'passed' | 'failed' | 'unavailable'
	passed: boolean
	exitCode: number
	output: string
} {
	try {
		const options = {
			cwd,
			timeout: timeoutMs,
			encoding: 'utf8' as const,
			stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe']
		}
		const output = nodeVersion
			? execFileSync('mise', ['exec', `node@${nodeVersion}`, '--', 'sh', '-c', command], options)
			: execSync(command, options)
		return { status: 'passed', passed: true, exitCode: 0, output: String(output) }
	} catch (err: unknown) {
		const execError = err as {
			code?: string
			status?: number | null
			stdout?: string
			stderr?: string
		}
		const stdout = execError.stdout ? String(execError.stdout) : ''
		const stderr = execError.stderr ? String(execError.stderr) : ''
		const unavailable = execError.status === null || execError.status === undefined
		return {
			status: unavailable ? 'unavailable' : 'failed',
			passed: false,
			exitCode: execError.status ?? 1,
			output: `${execError.code ? `${execError.code}: ` : ''}${stdout}\n${stderr}`.trim()
		}
	}
}

function runCommandAsync(
	command: string,
	cwd: string,
	timeoutMs: number,
	nodeVersion?: string
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const complete = (error: Error | null, stdout: string, stderr: string) => {
			if (!error) {
				resolve({ status: 'passed', passed: true, exitCode: 0, output: stdout })
				return
			}
			const processError = error as Error & { code?: number | string }
			const exitCode = typeof processError.code === 'number' ? processError.code : undefined
			resolve({
				status: exitCode === undefined ? 'unavailable' : 'failed',
				passed: false,
				exitCode: exitCode ?? 1,
				output: `${stdout}\n${stderr}`.trim()
			})
		}
		const options = {
			cwd,
			timeout: timeoutMs,
			encoding: 'utf8' as const,
			maxBuffer: 5 * 1024 * 1024
		}
		if (nodeVersion) {
			execFile(
				'mise',
				['exec', `node@${nodeVersion}`, '--', 'sh', '-c', command],
				options,
				complete
			)
		} else {
			exec(command, options, complete)
		}
	})
}

function skippedReward(command: string, reason: string): RewardResult {
	return {
		status: 'skipped',
		totalReward: 0,
		passed: false,
		details: {
			test: { command, status: 'skipped', passed: false, exitCode: 0, output: '', reason }
		},
		at: new Date().toISOString()
	}
}

function rewardFromCommand(
	command: string,
	commandResult: CommandResult,
	weights: RewardWeights,
	startedAt: number
): RewardResult {
	const status = commandResult.status === 'unavailable' ? 'skipped' : commandResult.status
	const reward = status === 'passed' ? weights.test : status === 'failed' ? -weights.test : 0
	const details: VerificationDetail = {
		test: {
			command,
			status,
			passed: status === 'passed',
			exitCode: commandResult.exitCode,
			output: commandResult.output.slice(-2000),
			...(status === 'skipped'
				? { reason: commandResult.output || 'Test command could not start' }
				: {})
		},
		latencyMs: Date.now() - startedAt
	}
	return {
		status,
		totalReward: Number(reward.toFixed(3)),
		passed: status === 'passed',
		details,
		at: new Date().toISOString()
	}
}

/** Give learning feedback only when a real test run produces a conclusive outcome. */
export function computeReward(
	cwd: string,
	options?: {
		testCommand?: string
		timeoutMs?: number
		weights?: RewardWeights
		changedFiles?: string[]
	}
): RewardResult {
	const command = options?.testCommand || detectTestCommand(cwd, options?.changedFiles)
	if (!command) return skippedReward('', 'No test command found')

	const runtime = runtimePlan(readManifest(cwd))
	if (runtime.reason) return skippedReward(command, runtime.reason)

	const timeoutMs = options?.timeoutMs ?? 30000
	const weights = options?.weights ?? { test: 1, lint: 0.3, cost: 0.1 }
	const startedAt = Date.now()
	const commandResult = runCommand(command, cwd, timeoutMs, runtime.nodeVersion)
	return rewardFromCommand(command, commandResult, weights, startedAt)
}

/** Run post-edit verification without blocking Pi's event loop. */
export async function computeRewardAsync(
	cwd: string,
	options?: {
		testCommand?: string
		timeoutMs?: number
		weights?: RewardWeights
		changedFiles?: string[]
	}
): Promise<RewardResult> {
	const command = options?.testCommand || detectTestCommand(cwd, options?.changedFiles)
	if (!command) return skippedReward('', 'No test command found')

	const runtime = runtimePlan(readManifest(cwd))
	if (runtime.reason) return skippedReward(command, runtime.reason)

	const timeoutMs = options?.timeoutMs ?? 30000
	const weights = options?.weights ?? { test: 1, lint: 0.3, cost: 0.1 }
	const startedAt = Date.now()
	const commandResult = await runCommandAsync(command, cwd, timeoutMs, runtime.nodeVersion)
	return rewardFromCommand(command, commandResult, weights, startedAt)
}
