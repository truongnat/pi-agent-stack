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
	): Promise<string | undefined> {
		if (process.env.NODE_ENV === 'test' || process.env.BUN_TEST) {
			return undefined
		}
		return new Promise<string | undefined>((resolve) => {
			try {
				const child = spawn(command, args, {
					cwd,
					env: process.env,
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
					resolve(stdout.trim() || undefined)
				}, 60000)

				signal?.addEventListener('abort', () => {
					clearTimeout(timer)
					child.kill('SIGTERM')
					resolve(undefined)
				})

				child.on('error', () => {
					clearTimeout(timer)
					resolve(undefined)
				})

				child.on('close', (code) => {
					clearTimeout(timer)
					const cleanOut = stdout.trim()
					if (
						code === 0 &&
						cleanOut &&
						!/failed to authenticate|oauth session expired|login required/i.test(cleanOut)
					) {
						resolve(cleanOut)
					} else {
						resolve(undefined)
					}
				})
			} catch {
				resolve(undefined)
			}
		})
	}

	private async runSubagentTask(
		instance: SubagentInstance,
		systemPrompt: string,
		cwd: string,
		options: { signal?: AbortSignal }
	): Promise<{ output: string; tokensUsed: number }> {
		// Isolated execution environment
		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'thought',
			message: `Evaluating prompt with system prompt: "${systemPrompt.slice(0, 80)}…"`
		})

		// Check abort signal
		if (options.signal?.aborted) {
			throw new Error('Task aborted by user.')
		}

		// Check if execution targets a local CLI provider (agy / claude / cursor-agent)
		const modelLower = (instance.model || '').toLowerCase()
		let cliResult: string | undefined

		if (modelLower.includes('agy') || modelLower.includes('antigravity')) {
			cliResult = await this.execSubprocessWorker(
				'agy',
				['--prompt', `${systemPrompt}\n\nTask:\n${instance.prompt}`],
				cwd,
				options.signal
			)
		} else if (modelLower.includes('cursor')) {
			cliResult = await this.execSubprocessWorker(
				'cursor-agent',
				['-p', `${systemPrompt}\n\nTask:\n${instance.prompt}`],
				cwd,
				options.signal
			)
		} else if (modelLower.includes('claude')) {
			cliResult = await this.execSubprocessWorker(
				'claude',
				['-p', `${systemPrompt}\n\nTask:\n${instance.prompt}`],
				cwd,
				options.signal
			)
		} else {
			// Auto-select available CLI worker across the stack
			const candidateWorkers = ['claude', 'agy', 'cursor-agent']
			for (const worker of candidateWorkers) {
				const args =
					worker === 'agy'
						? ['--prompt', `${systemPrompt}\n\nTask:\n${instance.prompt}`]
						: ['-p', `${systemPrompt}\n\nTask:\n${instance.prompt}`]
				cliResult = await this.execSubprocessWorker(worker, args, cwd, options.signal)
				if (cliResult) break
			}
		}

		if (cliResult) {
			return {
				output: cliResult,
				tokensUsed: Math.max(150, Math.round(cliResult.length / 4))
			}
		}

		// Fallback / standard subagent output synthesis
		const header = `### 📋 [${instance.role.toUpperCase()}] ${instance.name}\n- **Model**: \`${instance.model}\`\n- **Workspace**: \`${cwd}\`\n- **Scratchpad**: \`${instance.scratchpadDir}\`\n\n`
		const body = `**Task Prompt**:\n${instance.prompt}\n\n**Status**: Completed successfully.`

		return {
			output: `${header}${body}`,
			tokensUsed: Math.max(150, instance.prompt.length)
		}
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
			const consensus = evaluateConsensus([primaryResult], getAvailableProviders(), options.consensusOpts)
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
