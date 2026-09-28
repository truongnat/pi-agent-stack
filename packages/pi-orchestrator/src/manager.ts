import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { killProcessGroup } from 'pi-native-bridge'
import { loadOrchestratorConfig, type OrchestratorConfig } from './config.ts'
import { evaluateConsensus, type ConsensusOptions, type ConsensusResult } from './consensus.ts'
import { getAvailableProviders } from './guard.ts'
import {
	getAvailableModelPool,
	NATIVE_TOOL_NAMES,
	requiresNativeTools,
	selectOptimalModelForTask
} from './pool.ts'
import { type DagNode, promptWithDependencies } from './dag.ts'
import { createWorktree } from './worktree.ts'
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

/**
 * Recognizes a worker run that didn't finish normally: either the antigravity/cursor/
 * claude-code CLI's own wording ("timed out after Xms"), or the orchestrator's hard
 * wall-clock cap ("reached maximum execution limit of Xs") in `this.runner`'s
 * `maxTimeoutMs`. Both mean the same thing to the caller — retry on a different model
 * instead of trusting whatever partial output came back.
 */
export function isTimeoutOrCapStderr(stderr: string): boolean {
	return /timed out after|reached maximum execution limit/i.test(stderr)
}

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

/** `pi --mode rpc`: the prompt is sent over stdin (see WorkerRequest.rpc). */
export function buildPiWorkerArgs(opts: {
	model?: string
	sessionDir: string
	tools: string[]
}): string[] {
	const args = [
		'--mode',
		'rpc',
		'--session-dir',
		opts.sessionDir,
		'--no-skills',
		'--no-themes',
		'--tools',
		opts.tools.join(',')
	]
	if (opts.model && opts.model !== 'default') {
		args.unshift('--model', opts.model)
	}
	return args
}

export function shellJoin(bin: string, args: string[]): string {
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
	return [q(bin), ...args.map(q)].join(' ')
}

export function formatActivityMarkdown(elapsedSec: number, trail: string[]): string {
	const items = trail.map((line) => `- ${line}`).join('\n')
	return `*${elapsedSec}s*\n\n${items}`
}

export type WorkerRequest = {
	command: string
	args: string[]
	cwd: string
	signal?: AbortSignal | undefined
	onChunk?: ((chunk: string) => void) | undefined
	maxTimeoutMs: number
	/** Silence allowed before the first output byte (default 3 min). */
	firstByteTimeoutMs?: number
	env?: Record<string, string>
	instance?: SubagentInstance
	/**
	 * `pi --mode rpc` worker: the prompt goes over stdin, `send` is handed to the caller for
	 * steer/follow_up while it runs, and stdin closes (ending the worker) at agent_settled.
	 */
	rpc?: { prompt: string; onSend: (send: ((command: object) => boolean) | undefined) => void }
}

export type WorkerResult = { stdout: string; stderr: string; code: number | null }

/** Runs one worker process. Tests inject a fake; production spawns it. */
export type WorkerRunner = (request: WorkerRequest) => Promise<WorkerResult>

/** Read-only roles never get a CLI fallback that can write (`agy --dangerously-skip-permissions`). */
export function fallbackWorkers(
	allowedTools: string[],
	prompt: string
): Array<{ command: string; args: string[] }> {
	const canWrite = allowedTools.some((t) => t === 'edit' || t === 'write')
	if (!canWrite) {
		return [{ command: 'claude', args: ['-p', prompt, '--permission-mode', 'plan'] }]
	}
	return [
		{ command: 'agy', args: ['--dangerously-skip-permissions', '--prompt', prompt] },
		{ command: 'cursor-agent', args: ['-p', prompt] },
		{ command: 'claude', args: ['-p', prompt] }
	]
}

/**
 * Workers have no UI to ask "JEV unavailable, regex only?". When the user already said yes in
 * this session (jev-harness / typesafe gate share the answer), workers inherit it.
 */
export function workerEnv(): Record<string, string> {
	const consent = (globalThis as { piJevRegexOnly?: boolean }).piJevRegexOnly === true
	return { PI_SUBAGENT_WORKER: '1', ...(consent ? { PI_JEV_REGEX_ONLY: '1' } : {}) }
}

export class SubagentManager {
	private instances = new Map<string, SubagentInstance>()
	private dispatchedProviderCounts: Record<string, number> = {}
	private runner: WorkerRunner
	public config: OrchestratorConfig
	public scratchpadRoot: string

	constructor(config?: Partial<OrchestratorConfig>, options: { runner?: WorkerRunner } = {}) {
		this.runner = options.runner ?? ((r) => this.execSubprocessWorker(r))
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

	/** Drops finished subagents; running ones stay so they can still be listed and killed. */
	public clearHistory(): void {
		for (const [id, instance] of this.instances) {
			if (instance.status !== 'running') this.instances.delete(id)
		}
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
		// The tools a task asks for, capped by what its role may use.
		const tools = task.tools
			? roleDef.allowedTools.filter((t) => task.tools?.includes(t))
			: roleDef.allowedTools
		const requiresTools = requiresNativeTools(tools)
		const modelSelection = selectOptimalModelForTask(
			task,
			getAvailableModelPool(),
			this.dispatchedProviderCounts,
			requiresTools
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
						allowedTools: tools,
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
		if (requiresTools && !modelSelection.supportsTools) {
			this.logToScratchpad(instance, {
				timestamp: Date.now(),
				type: 'error',
				message: `No tool-capable model was available for [${task.role}]; "${modelSelection.provider}" runs in CLI compatibility mode and cannot execute ${tools.join(', ')}. ${modelSelection.rationale}`
			})
		}

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

			// Write-capable tasks can run in their own git worktree and return a patch.
			const canWrite = tools.some((t) => t === 'edit' || t === 'write' || t === 'bash')
			const worktree =
				(task.isolateWorkspace ?? this.config.isolateWorkspace) && canWrite
					? await createWorktree(cwd, scratchpadDir)
					: undefined
			let executionOutput: { output: string; tokensUsed: number }
			try {
				executionOutput = await this.runSubagentTask(
					instance,
					roleDef.systemPrompt,
					tools,
					worktree?.cwd ?? cwd,
					{ ...options, hardTimeoutMs: task.timeoutMs }
				)
			} finally {
				const changes = await worktree?.finish()
				if (changes) instance.patch = changes
			}
			if (instance.patch) {
				const { patchPath, files } = instance.patch
				executionOutput.output +=
					files.length > 0
						? `\n\n**Isolated workspace**: ${files.length} file(s) changed (${files.join(', ')}). Your checkout is untouched; review and apply with \`git apply ${patchPath}\`.`
						: '\n\n**Isolated workspace**: no files changed.'
			}
			// A kill that raced the last output must not turn into "completed".
			if (instance.status === 'killed') throw new Error('Subagent was killed by supervisor.')

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

	private async execSubprocessWorker(request: WorkerRequest): Promise<WorkerResult> {
		const { command, args, cwd, signal, onChunk, instance, rpc } = request
		const maxTimeoutMs = request.maxTimeoutMs
		const extraEnv = request.env ?? {}
		const firstByteTimeoutMs = request.firstByteTimeoutMs ?? 180_000
		const envPath = `${homedir()}/.bun/bin:${homedir()}/.local/bin:${process.env.PATH || ''}`
		const env = { ...process.env, PATH: envPath, ...extraEnv }
		// 3 min until first byte; 8 min of silence after the worker has streamed (Codex thinking gaps).
		let idleTimeoutMs = firstByteTimeoutMs

		return new Promise((resolve) => {
			try {
				const startTime = Date.now()
				const child = spawn(command, args, {
					cwd,
					env,
					detached: process.platform !== 'win32',
					stdio: [rpc ? 'pipe' : 'ignore', 'pipe', 'pipe']
				})
				if (instance && child.pid) {
					instance.pid = child.pid
				}
				let stdout = ''
				let stderr = ''
				let rpcLine = ''
				let rpcError: string | undefined
				const send = (cmd: object): boolean => {
					if (!child.stdin || child.stdin.writableEnded || child.exitCode !== null) return false
					child.stdin.write(`${JSON.stringify(cmd)}\n`)
					return true
				}
				// JSONL records split on LF only (readline would also split on U+2028 inside JSON).
				const onRpcRecord = (rec: Record<string, unknown>) => {
					if (rec.type === 'agent_settled') {
						rpc?.onSend(undefined)
						child.stdin?.end()
					} else if (
						rec.type === 'extension_ui_request' &&
						['select', 'confirm', 'input', 'editor'].includes(String(rec.method))
					) {
						// Nobody can answer a worker's dialog: decline, as a headless run would.
						send({ type: 'extension_ui_response', id: rec.id, cancelled: true })
					} else if (rec.type === 'agent_end' && Array.isArray(rec.messages)) {
						const last = [...(rec.messages as Array<Record<string, unknown>>)]
							.reverse()
							.find((m) => m.role === 'assistant')
						rpcError =
							last?.stopReason === 'error'
								? String(last.errorMessage || 'model request failed')
								: undefined
					}
				}
				if (rpc) {
					child.stdin?.on('error', () => undefined)
					rpc.onSend(send)
					send({ type: 'prompt', message: rpc.prompt })
				}
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

				// String decoding keeps multi-byte characters split across chunks intact.
				child.stdout?.setEncoding('utf8')
				child.stderr?.setEncoding('utf8')
				child.stdout?.on('data', (str: string) => {
					stdout += str
					if (!sawStream) {
						sawStream = true
						idleTimeoutMs = 480_000
					}
					resetIdleTimer()
					if (rpc) {
						const lines = (rpcLine + str).split('\n')
						rpcLine = lines.pop() ?? ''
						for (const line of lines) {
							try {
								onRpcRecord(JSON.parse(line) as Record<string, unknown>)
							} catch {
								// Not a protocol record.
							}
						}
					}
					if (onChunk) onChunk(str)
				})
				child.stderr?.on('data', (str: string) => {
					stderr += str
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
					rpc?.onSend(undefined)
					// An RPC worker exits 0 after a failed run too; the last reply says it failed.
					if (rpcError && code === 0) {
						resolve({ stdout: stdout.trim(), stderr: rpcError, code: 1 })
						return
					}
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
		allowedTools: string[],
		cwd: string,
		options: {
			signal?: AbortSignal
			onProgress?: (p: SubagentProgressEvent) => void
			/** Hard cap for the pi worker (default 15 min). */
			hardTimeoutMs?: number | undefined
		}
	): Promise<{ output: string; tokensUsed: number }> {
		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'thought',
			message: `Evaluating prompt with system prompt: "${systemPrompt.slice(0, 80)}…"`
		})

		if (options.signal?.aborted) {
			throw new Error('Task aborted by user.')
		}

		const fullPrompt = `${systemPrompt}\n\nTask:\n${instance.prompt}`
		const builtInAllowed = allowedTools.filter((t) => NATIVE_TOOL_NAMES.includes(t))
		const requiresTools = requiresNativeTools(builtInAllowed)

		// 1. Try Native Pi Subagent Execution (Primary & Most Capable)
		// Crucial: Load extensions so custom providers (antigravity, cursor, claude) are available,
		// but set PI_SUBAGENT_WORKER=1 to prevent recursive orchestrator nesting.
		const workerSessionDir = join(instance.scratchpadDir, 'pi-session')
		mkdirSync(workerSessionDir, { recursive: true })
		const piArgs = buildPiWorkerArgs({
			model: instance.model,
			sessionDir: workerSessionDir,
			tools: builtInAllowed
		})
		const rpc = {
			prompt: fullPrompt,
			onSend: (send: ((command: object) => boolean) | undefined) => {
				instance.send = send
			}
		}

		this.logToScratchpad(instance, {
			timestamp: Date.now(),
			type: 'info',
			message: `Dispatching native pi worker (--mode rpc) with model "${instance.model}" and tools: [${builtInAllowed.join(', ')}]`
		})

		let jsonBuf = ''
		let assembledAssistant = ''
		let streamTokens = 0
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
				if (summary.tokens) streamTokens += summary.tokens
			})
		}
		/** Real usage from the worker stream; the length estimate only when a worker reports none. */
		const tokensFor = (output: string) =>
			streamTokens || Math.max(150, Math.round(output.length / 4))
		const stopped = () => {
			if (instance.status === 'killed') throw new Error('Subagent was killed by supervisor.')
			if (options.signal?.aborted) throw new Error('Task aborted by user.')
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
			let piResult = await this.runner({
				command: 'pi',
				args: piArgs,
				cwd,
				signal: options.signal,
				onChunk: handlePiJsonChunk,
				maxTimeoutMs: options.hardTimeoutMs ?? 900_000,
				env: workerEnv(),
				rpc,
				instance
			})
			if (!assembledAssistant && piResult.stdout) {
				consumeJsonl(`${piResult.stdout}\n`, (obj) => {
					if (!obj || typeof obj !== 'object') return
					const summary = summarizeJsonEvent(obj as Record<string, unknown>)
					if (summary.assistantFinal) assembledAssistant = summary.assistantFinal
				})
			}
			if (piResult.code === 0) {
				const output = assembledAssistant.trim() || '(worker finished with no assistant text)'
				return { output, tokensUsed: tokensFor(output) }
			}
			// Esc or /agents kill: stop here instead of retrying or falling back to other CLIs.
			stopped()

			if (piResult.stderr) {
				this.logToScratchpad(instance, {
					timestamp: Date.now(),
					type: 'error',
					message: `pi worker notice/error: ${piResult.stderr.slice(0, 300)}`
				})
			}

			const timedOut = isTimeoutOrCapStderr(piResult.stderr || '')
			const quotaHit = QUOTA_RE.test(piResult.stderr || '')
			const primaryFailureReason = (piResult.stderr || 'unknown error').trim().slice(0, 200)
			const degradedNote = (source: string): string =>
				`> ⏱️ **Lưu ý:** lần chạy gốc (model \`${instance.model}\`) không hoàn tất bình thường (${primaryFailureReason}). Câu trả lời dưới đây đến từ ${source} — kiểm tra lại trước khi coi là kết luận cuối.\n\n`
			if ((timedOut || quotaHit) && instance.model && instance.model !== 'default') {
				const fallback = selectOptimalModelForTask(
					{ role: instance.role, prompt: instance.prompt },
					getAvailableModelPool().filter((m) => m.fullModelName !== instance.model),
					this.dispatchedProviderCounts,
					requiresTools
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
					streamTokens = 0
					piResult = await this.runner({
						command: 'pi',
						args: retryArgs,
						cwd,
						signal: options.signal,
						onChunk: handlePiJsonChunk,
						maxTimeoutMs: options.hardTimeoutMs ?? 900_000,
						env: workerEnv(),
						rpc,
						instance
					})
					if (piResult.code === 0) {
						if (!assembledAssistant && piResult.stdout) {
							consumeJsonl(`${piResult.stdout}\n`, (obj) => {
								if (!obj || typeof obj !== 'object') return
								const summary = summarizeJsonEvent(obj as Record<string, unknown>)
								if (summary.assistantFinal) assembledAssistant = summary.assistantFinal
							})
						}
						const output = assembledAssistant.trim() || '(worker finished with no assistant text)'
						return {
							output: degradedNote(`model dự phòng \`${instance.model}\``) + output,
							tokensUsed: tokensFor(output)
						}
					}
					stopped()
				}
			}

			// 2. Try secondary CLI workers if the pi runner failed. Async and abortable, so Esc and
			// /agents kill reach them and the TUI keeps running.
			for (const worker of fallbackWorkers(allowedTools, fullPrompt)) {
				stopped()
				options.onProgress?.({
					id: instance.id,
					role: instance.role,
					name: instance.name,
					status: 'running',
					currentActivity: `Trying fallback worker: ${worker.command}...`
				})
				const fallback = await this.runner({
					command: worker.command,
					args: worker.args,
					cwd,
					signal: options.signal,
					onChunk: handlePlainChunk,
					maxTimeoutMs: 600_000,
					// `claude -p` / `agy --prompt` print nothing until they finish.
					firstByteTimeoutMs: 600_000,
					instance
				})
				const ok =
					fallback.code === 0 &&
					fallback.stdout &&
					!/failed to authenticate|oauth session expired|login required/i.test(fallback.stdout)
				if (ok) {
					return {
						output: degradedNote(`fallback CLI (\`${worker.command}\`)`) + fallback.stdout,
						tokensUsed: Math.max(150, Math.round(fallback.stdout.length / 4))
					}
				}
			}
			stopped()

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

	/** Last task graph and each node's status, for /agents dag. */
	public lastDag: { nodes: DagNode[]; status: Map<string, string> } = {
		nodes: [],
		status: new Map()
	}

	/**
	 * Runs tasks as a dependency graph: a task starts once everything in its dependsOn has
	 * completed (up to maxConcurrentSubagents at a time) and gets their outputs in its prompt.
	 * If a dependency fails, is killed or is skipped, its dependents are skipped, not run.
	 */
	public async invokeDag(
		nodes: DagNode[],
		cwd: string,
		options: { signal?: AbortSignal; onProgress?: (p: SubagentProgressEvent) => void } = {}
	): Promise<SubagentExecutionResult[]> {
		const status = new Map<string, string>(nodes.map((n) => [n.id, 'pending']))
		this.lastDag = { nodes, status }
		const done = new Map<string, SubagentExecutionResult>()
		const results = new Map<string, SubagentExecutionResult>()
		const maxConcurrent = Math.max(1, this.config.maxConcurrentSubagents ?? 4)
		const running = new Map<string, Promise<void>>()

		const skip = (n: DagNode, why: string) => {
			status.set(n.id, 'skipped')
			results.set(n.id, {
				id: n.id,
				role: n.role,
				name: n.name ?? n.id,
				prompt: n.prompt,
				status: 'skipped',
				output: '',
				error: why,
				tokensUsed: 0,
				durationMs: 0,
				scratchpadDir: ''
			})
		}

		for (;;) {
			// Settle what can no longer run, then start what is ready.
			for (const n of nodes) {
				if (status.get(n.id) !== 'pending') continue
				const blocker = n.dependsOn.find((d) => {
					const s = status.get(d)
					return s === 'failed' || s === 'killed' || s === 'skipped'
				})
				if (blocker) skip(n, `Skipped: dependency "${blocker}" ${status.get(blocker)}.`)
				else if (options.signal?.aborted) skip(n, 'Skipped: aborted.')
			}
			const ready = nodes.filter(
				(n) =>
					status.get(n.id) === 'pending' && n.dependsOn.every((d) => status.get(d) === 'completed')
			)
			for (const n of ready) {
				if (running.size >= maxConcurrent) break
				status.set(n.id, 'running')
				const task: SubagentTask = { ...n, prompt: promptWithDependencies(n, done) }
				running.set(
					n.id,
					this.spawnSubagent(task, cwd, options).then((r) => {
						status.set(n.id, r.status)
						results.set(n.id, r)
						if (r.status === 'completed') done.set(n.id, r)
						running.delete(n.id)
					})
				)
			}
			if (running.size === 0) break
			await Promise.race(running.values())
		}
		return nodes.map((n) => results.get(n.id)!).filter(Boolean)
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
			prompt: `Review and verify the following output produced by [${primaryTask.role}]:\n\n${primaryResult.output}\n\nEnd your reply with exactly one line: \`VERDICT: PASS\` or \`VERDICT: FAIL\`.`,
			name: `${role}_consensus_check`
		}))

		const verificationResults = await this.invokeBatch(verifyTasks, cwd, true, options)

		// 3. Evaluate consensus across all participating agents
		const allResults = [primaryResult, ...verificationResults]
		const availableProviders = getAvailableProviders()
		// Every verification task votes by its VERDICT line, whatever its role name.
		const consensus = evaluateConsensus(allResults, availableProviders, {
			...options.consensusOpts,
			verifierIds: verificationResults.map((r) => r.id)
		})

		return {
			primaryResult,
			verificationResults,
			consensus
		}
	}
}
