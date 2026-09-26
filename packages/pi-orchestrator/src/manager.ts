import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadOrchestratorConfig, type OrchestratorConfig } from './config.ts'
import { evaluateConsensus, type ConsensusOptions, type ConsensusResult } from './consensus.ts'
import { getAvailableProviders } from './guard.ts'
import { getRoleDefinition } from './roster.ts'
import type {
	SubagentExecutionResult,
	SubagentInstance,
	SubagentLogEntry,
	SubagentTask
} from './types.ts'

export class SubagentManager {
	private instances = new Map<string, SubagentInstance>()
	public config: OrchestratorConfig
	public scratchpadRoot: string

	constructor(config?: Partial<OrchestratorConfig>) {
		this.config = { ...loadOrchestratorConfig(), ...(config ?? {}) }
		this.scratchpadRoot =
			this.config.scratchpadRoot ?? join(homedir(), '.pi-orchestrator', 'scratchpads')
		try {
			mkdirSync(this.scratchpadRoot, { recursive: true })
		} catch {
			// Directory creation fallback
		}
	}

	public getSubagent(id: string): SubagentInstance | undefined {
		return this.instances.get(id)
	}

	public listSubagents(): SubagentInstance[] {
		return Array.from(this.instances.values())
	}

	public clearHistory(): void {
		this.instances.clear()
	}

	public killSubagent(id: string): boolean {
		const instance = this.instances.get(id)
		if (!instance || instance.status !== 'running') return false
		instance.status = 'killed'
		instance.completedAt = Date.now()
		instance.error = 'Subagent was killed by supervisor.'
		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'error',
			message: 'Subagent terminated by kill request.'
		})
		return true
	}

	public killAll(): number {
		let count = 0
		for (const instance of this.instances.values()) {
			if (instance.status === 'running') {
				instance.status = 'killed'
				instance.completedAt = Date.now()
				instance.error = 'Subagent was killed by supervisor.'
				count++
			}
		}
		return count
	}

	private logToScratchpad(instance: SubagentInstance, entry: SubagentLogEntry): void {
		instance.logs.push(entry)
		try {
			const logFile = join(instance.scratchpadDir, 'log.jsonl')
			appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8')
		} catch {
			// Avoid failing on log write
		}
	}

	public async spawnSubagent(
		task: SubagentTask,
		cwd: string,
		options: { signal?: AbortSignal } = {}
	): Promise<SubagentExecutionResult> {
		const id = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
		const roleDef = getRoleDefinition(task.role)
		const model = task.modelOverride || roleDef.defaultModelTier
		const name = task.name || `${task.role}_${id.slice(-4)}`
		const scratchpadDir = join(this.scratchpadRoot, id)

		mkdirSync(scratchpadDir, { recursive: true })

		const instance: SubagentInstance = {
			id,
			role: task.role,
			name,
			status: 'running',
			prompt: task.prompt,
			model,
			startedAt: Date.now(),
			tokensUsed: 0,
			scratchpadDir,
			logs: []
		}

		this.instances.set(id, instance)

		// Initialize scratchpad metadata
		try {
			writeFileSync(
				join(scratchpadDir, 'task.json'),
				JSON.stringify(
					{
						id,
						role: task.role,
						name,
						model,
						prompt: task.prompt,
						allowedTools: task.tools || roleDef.allowedTools,
						cwd,
						startedAt: instance.startedAt
					},
					null,
					2
				),
				'utf8'
			)
		} catch {
			// Ignore init write error
		}

		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'info',
			message: `Subagent "${name}" (${task.role}) started with model "${model}".`
		})

		const startTime = performance.now()

		try {
			if (options.signal?.aborted) {
				throw new Error('Aborted before subagent execution started.')
			}

			// Execution via isolated subagent runner
			const executionOutput = await this.runSubagentTask(
				instance,
				roleDef.systemPrompt,
				cwd,
				options
			)

			instance.status = 'completed'
			instance.completedAt = Date.now()
			instance.output = executionOutput.output
			instance.tokensUsed = executionOutput.tokensUsed

			try {
				writeFileSync(join(scratchpadDir, 'output.md'), executionOutput.output, 'utf8')
			} catch {
				// Ignore output write error
			}

			this.logToScratchpad(instance, {
				timestamp: Date.now(),
				type: 'info',
				message: `Subagent "${name}" completed in ${Math.round(performance.now() - startTime)}ms.`
			})

			return {
				id: instance.id,
				role: instance.role,
				name: instance.name,
				status: 'completed',
				output: executionOutput.output,
				tokensUsed: executionOutput.tokensUsed,
				durationMs: Math.round(performance.now() - startTime),
				scratchpadDir: instance.scratchpadDir
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err)
			instance.status = instance.status === 'killed' ? 'killed' : 'failed'
			instance.completedAt = Date.now()
			instance.error = errMsg

			this.logToScratchpad(instance, {
				timestamp: Date.now(),
				type: 'error',
				message: `Subagent failed: ${errMsg}`
			})

			return {
				id: instance.id,
				role: instance.role,
				name: instance.name,
				status: instance.status,
				output: '',
				error: errMsg,
				tokensUsed: instance.tokensUsed,
				durationMs: Math.round(performance.now() - startTime),
				scratchpadDir: instance.scratchpadDir
			}
		}
	}

	private async execSubprocessWorker(
		command: string,
		args: string[],
		cwd: string,
		signal?: AbortSignal
	): Promise<{ stdout: string; stderr: string; code: number | null }> {
		const envPath = `${homedir()}/.bun/bin:${homedir()}/.local/bin:${process.env.PATH || ''}`
		const env = { ...process.env, PATH: envPath }

		return new Promise((resolve) => {
			try {
				const child = spawn(command, args, {
					cwd,
					env,
					stdio: ['ignore', 'pipe', 'pipe']
				})
				let stdout = ''
				let stderr = ''

				child.stdout?.on('data', (chunk) => {
					stdout += chunk.toString()
				})
				child.stderr?.on('data', (chunk) => {
					stderr += chunk.toString()
				})

				const timer = setTimeout(() => {
					child.kill('SIGTERM')
					resolve({
						stdout: stdout.trim(),
						stderr: stderr.trim() || 'Process timed out after 60s',
						code: -1
					})
				}, 60000)

				signal?.addEventListener('abort', () => {
					clearTimeout(timer)
					child.kill('SIGTERM')
					resolve({ stdout: stdout.trim(), stderr: 'Aborted by signal', code: -1 })
				})

				child.on('error', (err) => {
					clearTimeout(timer)
					resolve({ stdout: '', stderr: err.message, code: -1 })
				})

				child.on('close', (code) => {
					clearTimeout(timer)
					resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
				})
			} catch (err) {
				resolve({
					stdout: '',
					stderr: err instanceof Error ? err.message : String(err),
					code: -1
				})
			}
		})
	}

	private async runSubagentTask(
		instance: SubagentInstance,
		systemPrompt: string,
		cwd: string,
		options: { signal?: AbortSignal }
	): Promise<{ output: string; tokensUsed: number }> {
		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'thought',
			message: `Evaluating prompt with system prompt: "${systemPrompt.slice(0, 80)}…"`
		})

		if (options.signal?.aborted) {
			throw new Error('Task aborted by user.')
		}

		// Unit test mock mode
		if (process.env.NODE_ENV === 'test' || process.env.BUN_TEST) {
			const mockHeader = `### 📋 [${instance.role.toUpperCase()}] ${instance.name}\n- **Model**: \`${instance.model}\`\n- **Workspace**: \`${cwd}\`\n- **Scratchpad**: \`${instance.scratchpadDir}\`\n\n`
			const mockBody = `**Task Prompt**:\n${instance.prompt}\n\n**Status**: Completed successfully.`
			return {
				output: `${mockHeader}${mockBody}`,
				tokensUsed: Math.max(150, instance.prompt.length)
			}
		}

		const fullPrompt = `${systemPrompt}\n\nTask:\n${instance.prompt}`
		const roleDef = getRoleDefinition(instance.role)
		const allowedTools = roleDef.allowedTools || ['read', 'grep', 'find', 'ls']

		// 1. Try Native Pi Subagent Execution (Primary & Most Capable)
		const piArgs = ['--tools', allowedTools.join(','), '-p', fullPrompt]
		if (
			instance.model &&
			instance.model !== 'flash' &&
			instance.model !== 'sonnet' &&
			instance.model !== 'mini' &&
			instance.model !== 'pro'
		) {
			piArgs.unshift('--model', instance.model)
		}

		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'info',
			message: `Dispatching native pi worker with tools: [${allowedTools.join(', ')}]`
		})

		const piResult = await this.execSubprocessWorker('pi', piArgs, cwd, options.signal)
		if (piResult.code === 0 && piResult.stdout) {
			return {
				output: piResult.stdout,
				tokensUsed: Math.max(150, Math.round(piResult.stdout.length / 4))
			}
		}

		if (piResult.stderr) {
			this.logToScratchpad(instance, {
				timestamp: Date.now(),
				type: 'error',
				message: `pi worker notice/error: ${piResult.stderr.slice(0, 300)}`
			})
		}

		// 2. Try Secondary CLI Workers if pi runner failed
		const candidateWorkers = ['agy', 'cursor-agent', 'claude']
		for (const worker of candidateWorkers) {
			const args =
				worker === 'agy'
					? ['--dangerously-skip-permissions', '--prompt', fullPrompt]
					: ['-p', fullPrompt]

			const res = await this.execSubprocessWorker(worker, args, cwd, options.signal)
			if (
				res.code === 0 &&
				res.stdout &&
				!/failed to authenticate|oauth session expired|login required/i.test(res.stdout)
			) {
				return {
					output: res.stdout,
					tokensUsed: Math.max(150, Math.round(res.stdout.length / 4))
				}
			}
		}

		// If all execution backends failed, DO NOT fake success. Report actual failure!
		const failureReason = piResult.stderr || 'Subprocess exited with non-zero code or empty output'
		throw new Error(
			`Subagent "${instance.name}" (${instance.role}) failed to execute. Cause: ${failureReason}`
		)
	}

	public async invokeBatch(
		tasks: SubagentTask[],
		cwd: string,
		parallel = true,
		options: { signal?: AbortSignal } = {}
	): Promise<SubagentExecutionResult[]> {
		if (parallel) {
			return Promise.all(tasks.map((task) => this.spawnSubagent(task, cwd, options)))
		}

		const results: SubagentExecutionResult[] = []
		for (const task of tasks) {
			if (options.signal?.aborted) break
			const res = await this.spawnSubagent(task, cwd, options)
			results.push(res)
		}
		return results
	}

	/**
	 * Executes a primary coding/solution task and independently verifies it across
	 * reviewer/tester subagents, returning an aggregated ConsensusResult.
	 */
	public async invokeWithConsensus(
		primaryTask: SubagentTask,
		reviewerRoles: string[] = ['reviewer', 'tester'],
		cwd: string,
		options: { signal?: AbortSignal; consensusOpts?: ConsensusOptions } = {}
	): Promise<{
		primaryResult: SubagentExecutionResult
		verificationResults: SubagentExecutionResult[]
		consensus: ConsensusResult
	}> {
		// 1. Run primary task (e.g. Coder)
		const primaryResult = await this.spawnSubagent(primaryTask, cwd, options)

		// If primary task completely failed, short-circuit
		if (primaryResult.status === 'failed' || primaryResult.status === 'killed') {
			const consensus = evaluateConsensus(
				[primaryResult],
				getAvailableProviders(),
				options.consensusOpts
			)
			return {
				primaryResult,
				verificationResults: [],
				consensus
			}
		}

		// 2. Spawn independent verification tasks in parallel
		const verifyTasks: SubagentTask[] = reviewerRoles.map((role) => ({
			role,
			prompt: `Review and verify the following output produced by [${primaryTask.role}]:\n\n${primaryResult.output}`,
			name: `${role}_consensus_check`
		}))

		const verificationResults = await this.invokeBatch(verifyTasks, cwd, true, options)

		// 3. Evaluate consensus across all participating agents
		const allResults = [primaryResult, ...verificationResults]
		const availableProviders = getAvailableProviders()
		const consensus = evaluateConsensus(allResults, availableProviders, options.consensusOpts)

		return {
			primaryResult,
			verificationResults,
			consensus
		}
	}
}
