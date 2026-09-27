import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { killProcessGroup, spawnSupervised } from 'pi-native-bridge'
import { loadOrchestratorConfig, type OrchestratorConfig } from './config.ts'
import { evaluateConsensus, type ConsensusOptions, type ConsensusResult } from './consensus.ts'
import { getAvailableProviders } from './guard.ts'
import { getAvailableModelPool, selectOptimalModelForTask } from './pool.ts'
import { consumeJsonl, summarizeJsonEvent } from './json-stream.ts'
import { generateAgentCodename, getRoleDefinition, withModelSuffix } from './roster.ts'
import type {
	SubagentExecutionResult,
	SubagentInstance,
	SubagentLogEntry,
	SubagentProgressEvent,
	SubagentTask
} from './types.ts'

const QUOTA_RE =
	/RESOURCE_EXHAUSTED|individual quota reached|quota reached|quota exhausted|rate.?limit exceeded|HTTP 429\b|status(?:\s+code)?\s*429/i

export function describeIdleTimeout(opts: {
	idleSec: number
	elapsedSec: number
	model?: string
	stdout?: string
	stderr?: string
}): string {
	const blob = `${opts.stderr || ''}\n${opts.stdout || ''}`
	const modelBit = opts.model ? ` model=${opts.model}` : ''
	const base = `Process timed out after ${opts.idleSec}s of inactivity (total run: ${opts.elapsedSec}s)${modelBit}`
	if (QUOTA_RE.test(opts.stderr || '')) {
		return `${base}. Worker reported quota/rate-limit exhaustion — rotate account or pick another model.`
	}
	if (!blob.trim()) {
		return `${base}. No stdout/stderr — worker never streamed (hung connect or silent API).`
	}
	return `${base}. Stream went silent after progress (long thinking or stalled generation).`
}

export function shellJoin(bin: string, args: string[]): string {
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
	return [q(bin), ...args.map(q)].join(' ')
}

export function formatActivityMarkdown(elapsedSec: number, trail: string[]): string {
	const items = trail.map((line) => `- ${line}`).join('\n')
	return `*${elapsedSec}s*\n\n${items}`
}

export class SubagentManager {
	private instances = new Map<string, SubagentInstance>()
	private dispatchedProviderCounts: Record<string, number> = {}
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
		this.dispatchedProviderCounts = {}
	}

	public killSubagent(id: string): boolean {
		const instance = this.instances.get(id)
		if (!instance || instance.status !== 'running') return false
		instance.status = 'killed'
		instance.completedAt = Date.now()
		instance.error = 'Subagent was killed by supervisor.'
		if (instance.pid) {
			try {
				killProcessGroup(instance.pid, 15)
				setTimeout(() => {
					if (instance.pid) killProcessGroup(instance.pid, 9)
				}, 100)
			} catch {
				// Ignore kill error
			}
		}
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
				if (instance.pid) {
					try {
						killProcessGroup(instance.pid, 9)
					} catch {
						// Ignore kill error
					}
				}
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

	private pruneOldScratchpads(): void {
		try {
			const maxKeep = this.config.maxScratchpadsToKeep ?? 50
			const entries = readdirSync(this.scratchpadRoot, { withFileTypes: true })
				.filter((e) => e.isDirectory() && e.name.startsWith('subagent_'))
				.map((e) => {
					const fullPath = join(this.scratchpadRoot, e.name)
					try {
						const stats = statSync(fullPath)
						return { path: fullPath, mtime: stats.mtimeMs }
					} catch {
						return { path: fullPath, mtime: 0 }
					}
				})

			if (entries.length > maxKeep) {
				entries.sort((a, b) => a.mtime - b.mtime)
				const toRemove = entries.slice(0, entries.length - maxKeep)
				for (const item of toRemove) {
					try {
						rmSync(item.path, { recursive: true, force: true })
					} catch {
						// Ignore deletion error
					}
				}
			}
		} catch {
			// Directory traversal fallback
		}
	}

	public async spawnSubagent(
		task: SubagentTask,
		cwd: string,
		options: { signal?: AbortSignal; onProgress?: (p: SubagentProgressEvent) => void } = {}
	): Promise<SubagentExecutionResult> {
		this.pruneOldScratchpads()
		const id = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
		const roleDef = getRoleDefinition(task.role)
		const modelSelection = selectOptimalModelForTask(
			task,
			getAvailableModelPool(),
			this.dispatchedProviderCounts
		)
		const model = modelSelection.fullModelName
		this.dispatchedProviderCounts[modelSelection.provider] =
			(this.dispatchedProviderCounts[modelSelection.provider] || 0) + 1

		const name = generateAgentCodename(task.role, task.name, task.prompt, 'Senior', model)
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
		maxTimeoutMs = 600_000,
		extraEnv: Record<string, string> = {},
		instance?: SubagentInstance
	): Promise<{ stdout: string; stderr: string; code: number | null }> {
		const envPath = `${homedir()}/.bun/bin:${homedir()}/.local/bin:${process.env.PATH || ''}`
		const env = { ...process.env, PATH: envPath, ...extraEnv }
		// 3 min until first byte; 8 min of silence after the worker has streamed (Codex thinking gaps).
		let idleTimeoutMs = 180_000

		return new Promise((resolve) => {
			try {
				const startTime = Date.now()
				const child = spawn(command, args, {
					cwd,
					env,
					detached: process.platform !== 'win32',
					stdio: ['ignore', 'pipe', 'pipe']
				})
				if (instance && child.pid) {
					instance.pid = child.pid
				}
				let stdout = ''
				let stderr = ''
				let sawStream = false
				let idleTimer: ReturnType<typeof setTimeout> | null = null

				const resetIdleTimer = () => {
					if (idleTimer) clearTimeout(idleTimer)
					idleTimer = setTimeout(() => {
						if (child.pid) {
							killProcessGroup(child.pid, 15)
							setTimeout(() => {
								if (child.pid) killProcessGroup(child.pid, 9)
							}, 150)
						} else {
							child.kill('SIGTERM')
						}
						const elapsedSec = Math.round((Date.now() - startTime) / 1000)
						resolve({
							stdout: stdout.trim(),
							stderr: describeIdleTimeout({
								idleSec: Math.round(idleTimeoutMs / 1000),
								elapsedSec,
								model: instance?.model,
								stdout,
								stderr
							}),
							code: -1
						})
					}, idleTimeoutMs)
				}

				resetIdleTimer()

				child.stdout?.on('data', (chunk) => {
					const str = chunk.toString()
					stdout += str
					if (!sawStream) {
						sawStream = true
						idleTimeoutMs = 480_000
					}
					resetIdleTimer()
					if (onChunk) onChunk(str)
				})
				child.stderr?.on('data', (chunk) => {
					stderr += chunk.toString()
					if (!sawStream) {
						sawStream = true
						idleTimeoutMs = 480_000
					}
					resetIdleTimer()
				})

				const maxTimer = setTimeout(() => {
					if (idleTimer) clearTimeout(idleTimer)
					if (child.pid) {
						killProcessGroup(child.pid, 15)
						setTimeout(() => {
							if (child.pid) killProcessGroup(child.pid, 9)
						}, 150)
					} else {
						child.kill('SIGTERM')
					}
					resolve({
						stdout: stdout.trim(),
						stderr:
							stderr.trim() ||
							`Process reached maximum execution limit of ${Math.round(maxTimeoutMs / 1000)}s`,
						code: -1
					})
				}, maxTimeoutMs)

				signal?.addEventListener('abort', () => {
					if (idleTimer) clearTimeout(idleTimer)
					clearTimeout(maxTimer)
					if (child.pid) {
						killProcessGroup(child.pid, 9)
					} else {
						child.kill('SIGTERM')
					}
					resolve({ stdout: stdout.trim(), stderr: 'Aborted by signal', code: -1 })
				})

				child.on('error', (err) => {
					if (idleTimer) clearTimeout(idleTimer)
					clearTimeout(maxTimer)
					resolve({ stdout: '', stderr: err.message, code: -1 })
				})

				child.on('close', (code) => {
					if (idleTimer) clearTimeout(idleTimer)
					clearTimeout(maxTimer)
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
		// Crucial: Load extensions so custom providers (antigravity, cursor, claude) are available,
		// but set PI_SUBAGENT_WORKER=1 to prevent recursive orchestrator nesting.
		const piArgs = [
			'--mode',
			'json',
			'--no-session',
			'--no-skills',
			'--no-themes',
			'--tools',
			builtInAllowed.join(','),
			fullPrompt
		]
		if (instance.model && instance.model !== 'default') {
			piArgs.unshift('--model', instance.model)
		}

		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'info',
			message: `Dispatching native pi worker (--mode json) with model "${instance.model}" and tools: [${builtInAllowed.join(', ')}]`
		})

		let jsonBuf = ''
		let assembledAssistant = ''
		const activityTrail: string[] = []

		const emitActivity = (line: string) => {
			const trimmed = line.trim()
			if (!trimmed) return
			if (activityTrail[activityTrail.length - 1] !== trimmed) {
				activityTrail.push(trimmed)
				if (activityTrail.length > 5) activityTrail.shift()
			}
			const elapsedSec = Math.max(1, Math.floor((Date.now() - instance.startedAt) / 1000))
			options.onProgress?.({
				id: instance.id,
				role: instance.role,
				name: instance.name,
				status: 'streaming',
				currentActivity: formatActivityMarkdown(elapsedSec, activityTrail),
				previewMarkdown: assembledAssistant
			})
		}

		const ticker = setInterval(() => {
			const elapsedSec = Math.max(1, Math.floor((Date.now() - instance.startedAt) / 1000))
			if (activityTrail.length > 0) {
				options.onProgress?.({
					id: instance.id,
					role: instance.role,
					name: instance.name,
					status: 'streaming',
					currentActivity: formatActivityMarkdown(elapsedSec, activityTrail),
					previewMarkdown: assembledAssistant
				})
			} else {
				options.onProgress?.({
					id: instance.id,
					role: instance.role,
					name: instance.name,
					status: 'running',
					currentActivity: formatActivityMarkdown(elapsedSec, [
						'⏳ waiting for worker stream (thinking / tools / text)…'
					])
				})
			}
		}, 1200)

		const handlePiJsonChunk = (chunkStr: string) => {
			const cleaned = stripVTControlCharacters(chunkStr)
			jsonBuf = consumeJsonl(jsonBuf + cleaned, (obj) => {
				if (!obj || typeof obj !== 'object') return
				const rec = obj as Record<string, unknown>
				const summary = summarizeJsonEvent(rec)
				if (summary.activity) {
					emitActivity(summary.activity)
					const kind =
						rec.type === 'tool_execution_start' || rec.type === 'tool_execution_end'
							? 'tool'
							: summary.activity.startsWith('💭')
								? 'thought'
								: 'info'
					if (kind !== 'info' || rec.type === 'turn_start' || rec.type === 'text_end') {
						this.logToScratchpad(instance, {
							timestamp: Date.now(),
							type: kind,
							message: summary.activity
						})
					}
				}
				if (summary.assistantDelta) assembledAssistant += summary.assistantDelta
				if (summary.assistantFinal) assembledAssistant = summary.assistantFinal
			})
		}

		const handlePlainChunk = (chunkStr: string) => {
			const cleaned = stripVTControlCharacters(chunkStr)
			const line = cleaned
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l.length > 2)
				.pop()
			if (line) emitActivity(`✍️ ${line.slice(0, 90)}`)
		}

		try {
			let piResult = await this.execSubprocessWorker(
				'pi',
				piArgs,
				cwd,
				options.signal,
				handlePiJsonChunk,
				900_000,
				{ PI_SUBAGENT_WORKER: '1' },
				instance
			)
			if (!assembledAssistant && piResult.stdout) {
				consumeJsonl(`${piResult.stdout}\n`, (obj) => {
					if (!obj || typeof obj !== 'object') return
					const summary = summarizeJsonEvent(obj as Record<string, unknown>)
					if (summary.assistantFinal) assembledAssistant = summary.assistantFinal
				})
			}
			if (piResult.code === 0) {
				const output = assembledAssistant.trim() || '(worker finished with no assistant text)'
				return {
					output,
					tokensUsed: Math.max(150, Math.round(output.length / 4))
				}
			}

			if (piResult.stderr) {
				this.logToScratchpad(instance, {
					timestamp: Date.now(),
					type: 'error',
					message: `pi worker notice/error: ${piResult.stderr.slice(0, 300)}`
				})
			}

			const timedOut = /timed out after/i.test(piResult.stderr || '')
			const quotaHit = QUOTA_RE.test(piResult.stderr || '')
			if ((timedOut || quotaHit) && instance.model && instance.model !== 'default') {
				const fallback = selectOptimalModelForTask(
					{ role: instance.role, prompt: instance.prompt },
					getAvailableModelPool().filter((m) => m.fullModelName !== instance.model),
					this.dispatchedProviderCounts
				)
				if (fallback.fullModelName !== instance.model && fallback.fullModelName !== 'default') {
					this.dispatchedProviderCounts[fallback.provider] =
						(this.dispatchedProviderCounts[fallback.provider] || 0) + 1
					instance.model = fallback.fullModelName
					instance.name = withModelSuffix(instance.name, instance.model)
					options.onProgress?.({
						id: instance.id,
						role: instance.role,
						name: instance.name,
						status: 'running',
						currentActivity: `↻ retry with ${instance.model}`
					})
					this.logToScratchpad(instance, {
						timestamp: Date.now(),
						type: 'info',
						message: `Retrying on ${instance.model} after stall/quota.`
					})
					const retryArgs = [...piArgs]
					const modelFlag = retryArgs.indexOf('--model')
					if (modelFlag >= 0) retryArgs[modelFlag + 1] = instance.model
					else retryArgs.unshift('--model', instance.model)
					jsonBuf = ''
					assembledAssistant = ''
					piResult = await this.execSubprocessWorker(
						'pi',
						retryArgs,
						cwd,
						options.signal,
						handlePiJsonChunk,
						900_000,
						{ PI_SUBAGENT_WORKER: '1' },
						instance
					)
					if (piResult.code === 0) {
						if (!assembledAssistant && piResult.stdout) {
							consumeJsonl(`${piResult.stdout}\n`, (obj) => {
								if (!obj || typeof obj !== 'object') return
								const summary = summarizeJsonEvent(obj as Record<string, unknown>)
								if (summary.assistantFinal) assembledAssistant = summary.assistantFinal
							})
						}
						const output =
							assembledAssistant.trim() || '(worker finished with no assistant text)'
						return {
							output,
							tokensUsed: Math.max(150, Math.round(output.length / 4))
						}
					}
				}
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

				const supervised = spawnSupervised(shellJoin(worker, args), cwd, 600_000)
				if (supervised.stdout.trim()) handlePlainChunk(supervised.stdout)
				const ok =
					!supervised.timed_out &&
					supervised.exit_code === 0 &&
					supervised.stdout &&
					!/failed to authenticate|oauth session expired|login required/i.test(
						supervised.stdout
					)
				if (ok) {
					return {
						output: supervised.stdout,
						tokensUsed: Math.max(150, Math.round(supervised.stdout.length / 4))
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
		if (!parallel) {
			const results: SubagentExecutionResult[] = []
			for (const task of tasks) {
				if (options.signal?.aborted) break
				const res = await this.spawnSubagent(task, cwd, options)
				results.push(res)
			}
			return results
		}

		// Concurrency Pool Semaphore (prevents API rate limits and machine thrashing)
		const maxConcurrent = Math.max(1, this.config.maxConcurrentSubagents ?? 4)
		const results: SubagentExecutionResult[] = Array.from<SubagentExecutionResult>({
			length: tasks.length
		})
		let nextIndex = 0

		const worker = async () => {
			while (nextIndex < tasks.length) {
				if (options.signal?.aborted) break
				const index = nextIndex++
				const task = tasks[index]!
				results[index] = await this.spawnSubagent(task, cwd, options)
			}
		}

		const workers = Array.from({ length: Math.min(maxConcurrent, tasks.length) }, () => worker())
		await Promise.all(workers)
		return results.filter(Boolean)
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
