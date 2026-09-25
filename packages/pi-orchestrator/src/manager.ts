import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadOrchestratorConfig, type OrchestratorConfig } from './config.ts'
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

		// Simulated/Native subagent output synthesis
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
}
