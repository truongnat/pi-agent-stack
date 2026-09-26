import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { loadOrchestratorConfig, type OrchestratorConfig } from './config.ts'
import { evaluateConsensus, type ConsensusOptions, type ConsensusResult } from './consensus.ts'
import { getAvailableProviders } from './guard.ts'
import { getRoleDefinition } from './roster.ts'
import type {
	SubagentExecutionResult,
	SubagentInstance,
	SubagentLogEntry,
	SubagentProgressEvent,
	SubagentTask
} from './types.ts'

export class SubagentManager {
	private instances = new Map<string, SubagentInstance>()
	public config: OrchestratorConfig
	public scratchpadRoot: string

	constructor(config?: Partial<OrchestratorConfig>) {
		this.config = { ...loadOrchestratorConfig(), ...config }
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
		options: { signal?: AbortSignal; onProgress?: (p: SubagentProgressEvent) => void } = {}
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

		options.onProgress?.({
			id: instance.id,
			role: instance.role,
			name: instance.name,
			status: 'running',
			currentActivity: `Starting with model ${model}...`
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

			const durationMs = Math.round(performance.now() - startTime)

			this.logToScratchpad(instance, {
				timestamp: Date.now(),
				type: 'info',
				message: `Subagent "${name}" completed in ${durationMs}ms.`
			})

			options.onProgress?.({
				id: instance.id,
				role: instance.role,
				name: instance.name,
				status: 'completed',
				currentActivity: `Finished in ${durationMs}ms (${executionOutput.tokensUsed} tokens)`,
				tokensUsed: executionOutput.tokensUsed,
				elapsedMs: durationMs
			})

			return {
				id: instance.id,
				role: instance.role,
				name: instance.name,
				prompt: instance.prompt,
				status: 'completed',
				output: executionOutput.output,
				tokensUsed: executionOutput.tokensUsed,
				durationMs,
				scratchpadDir: instance.scratchpadDir
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err)
			const durationMs = Math.round(performance.now() - startTime)
			instance.status = instance.status === 'killed' ? 'killed' : 'failed'
			instance.completedAt = Date.now()
			instance.error = errMsg

			this.logToScratchpad(instance, {
				timestamp: Date.now(),
				type: 'error',
				message: `Subagent failed: ${errMsg}`
			})

			options.onProgress?.({
				id: instance.id,
				role: instance.role,
				name: instance.name,
				status: instance.status,
				currentActivity: `Failed: ${errMsg.slice(0, 80)}`,
				elapsedMs: durationMs
			})

			return {
				id: instance.id,
				role: instance.role,
				name: instance.name,
				prompt: instance.prompt,
				status: instance.status,
				output: '',
				error: errMsg,
				tokensUsed: instance.tokensUsed,
				durationMs,
				scratchpadDir: instance.scratchpadDir
			}
		}
	}

	private async execSubprocessWorker(
		command: string,
		args: string[],
		cwd: string,
		signal?: AbortSignal,
		onChunk?: (chunk: string) => void,
		timeoutMs = 180_000
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
					const str = chunk.toString()
					stdout += str
					if (onChunk) onChunk(str)
				})
				child.stderr?.on('data', (chunk) => {
					stderr += chunk.toString()
				})

				const timer = setTimeout(() => {
					child.kill('SIGTERM')
					resolve({
						stdout: stdout.trim(),
						stderr: stderr.trim() || `Process timed out after ${Math.round(timeoutMs / 1000)}s`,
						code: -1
					})
				}, timeoutMs)

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
		options: { signal?: AbortSignal; onProgress?: (p: SubagentProgressEvent) => void }
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
		const builtInAllowed = allowedTools.filter((t) =>
			['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls'].includes(t)
		)

		// 1. Try Native Pi Subagent Execution (Primary & Most Capable)
		// Crucial: Pass --no-extensions --no-skills --no-themes to avoid recursive plugin overhead
		const piArgs = [
			'--no-extensions',
			'--no-skills',
			'--no-themes',
			'--tools',
			builtInAllowed.join(','),
			'-p',
			fullPrompt
		]
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
			message: `Dispatching native pi worker with tools: [${builtInAllowed.join(', ')}]`
		})

		let streamedBytes = 0
		let latestLine = ''

		const ticker = setInterval(() => {
			const elapsedSec = Math.max(1, Math.floor((Date.now() - instance.startedAt) / 1000))
			if (streamedBytes > 0 && latestLine) {
				options.onProgress?.({
					id: instance.id,
					role: instance.role,
					name: instance.name,
					status: 'streaming',
					currentActivity: `(${elapsedSec}s) ✍️ ${latestLine.slice(0, 90)}`
				})
			} else {
				const phases = [
					'Analyzing task context & tools...',
					'Exploring workspace & files...',
					'Inspecting code & running actions...',
					'Synthesizing findings & formulating report...'
				]
				const phaseIndex = Math.min(Math.floor(elapsedSec / 8), phases.length - 1)
				options.onProgress?.({
					id: instance.id,
					role: instance.role,
					name: instance.name,
					status: 'running',
					currentActivity: `(${elapsedSec}s) ${phases[phaseIndex]}`
				})
			}
		}, 1200)

		const handleChunk = (chunkStr: string) => {
			streamedBytes += chunkStr.length
			const cleaned = stripVTControlCharacters(chunkStr)
			const lines = cleaned
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
			const line = lines.pop()
			if (line && line.length > 2) {
				latestLine = line
				const elapsedSec = Math.max(1, Math.floor((Date.now() - instance.startedAt) / 1000))
				options.onProgress?.({
					id: instance.id,
					role: instance.role,
					name: instance.name,
					status: 'streaming',
					currentActivity: `(${elapsedSec}s) ✍️ ${line.slice(0, 90)}`
				})
			}
		}

		try {
			const piResult = await this.execSubprocessWorker(
				'pi',
				piArgs,
				cwd,
				options.signal,
				handleChunk,
				180_000
			)
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

				options.onProgress?.({
					id: instance.id,
					role: instance.role,
					name: instance.name,
					status: 'running',
					currentActivity: `Trying fallback worker: ${worker}...`
				})

				const res = await this.execSubprocessWorker(worker, args, cwd, options.signal, handleChunk)
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
			const failureReason =
				piResult.stderr || 'Subprocess exited with non-zero code or empty output'
			throw new Error(
				`Subagent "${instance.name}" (${instance.role}) failed to execute. Cause: ${failureReason}`
			)
		} finally {
			clearInterval(ticker)
		}
	}

	public async invokeBatch(
		tasks: SubagentTask[],
		cwd: string,
		parallel = true,
		options: { signal?: AbortSignal; onProgress?: (p: SubagentProgressEvent) => void } = {}
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
		options: {
			signal?: AbortSignal
			consensusOpts?: ConsensusOptions
			onProgress?: (p: SubagentProgressEvent) => void
		} = {}
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
