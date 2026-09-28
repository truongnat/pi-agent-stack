import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface OrchestratorConfig {
	enabled: boolean
	guard: boolean
	alwaysOrchestrate: boolean
	minProvidersRequired: number
	maxConcurrentSubagents?: number
	maxScratchpadsToKeep?: number
	scratchpadRoot?: string
	/** Default for tasks that do not set isolate_workspace: run writers in a git worktree. */
	isolateWorkspace?: boolean
}

export const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'orchestrator.json')

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	enabled: true,
	guard: true,
	alwaysOrchestrate: true,
	minProvidersRequired: 2,
	maxConcurrentSubagents: 4,
	maxScratchpadsToKeep: 50,
	scratchpadRoot: join(homedir(), '.pi-orchestrator', 'scratchpads')
}

export function loadOrchestratorConfig(path = CONFIG_PATH): OrchestratorConfig {
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OrchestratorConfig>
		return {
			enabled: raw.enabled ?? DEFAULT_ORCHESTRATOR_CONFIG.enabled,
			guard: raw.guard ?? DEFAULT_ORCHESTRATOR_CONFIG.guard,
			alwaysOrchestrate: raw.alwaysOrchestrate ?? DEFAULT_ORCHESTRATOR_CONFIG.alwaysOrchestrate,
			minProvidersRequired:
				raw.minProvidersRequired ?? DEFAULT_ORCHESTRATOR_CONFIG.minProvidersRequired,
			maxConcurrentSubagents:
				raw.maxConcurrentSubagents ?? DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrentSubagents,
			maxScratchpadsToKeep:
				raw.maxScratchpadsToKeep ?? DEFAULT_ORCHESTRATOR_CONFIG.maxScratchpadsToKeep,
			scratchpadRoot: raw.scratchpadRoot ?? DEFAULT_ORCHESTRATOR_CONFIG.scratchpadRoot,
			isolateWorkspace: raw.isolateWorkspace ?? false
		}
	} catch {
		return { ...DEFAULT_ORCHESTRATOR_CONFIG }
	}
}

export function saveOrchestratorConfig(config: OrchestratorConfig, path = CONFIG_PATH): void {
	try {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
	} catch {
		// Ignore write errors if directory not accessible
	}
}
