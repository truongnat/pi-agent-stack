import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OrchestratorConfig {
	enabled: boolean
	guard: boolean
	minProvidersRequired: number
	scratchpadRoot?: string
}

export const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'orchestrator.json')

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	enabled: true,
	guard: true,
	minProvidersRequired: 2,
	scratchpadRoot: join(homedir(), '.pi-orchestrator', 'scratchpads')
}

export function loadOrchestratorConfig(path = CONFIG_PATH): OrchestratorConfig {
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OrchestratorConfig>
		return {
			enabled: raw.enabled ?? DEFAULT_ORCHESTRATOR_CONFIG.enabled,
			guard: raw.guard ?? DEFAULT_ORCHESTRATOR_CONFIG.guard,
			minProvidersRequired:
				raw.minProvidersRequired ?? DEFAULT_ORCHESTRATOR_CONFIG.minProvidersRequired,
			scratchpadRoot: raw.scratchpadRoot ?? DEFAULT_ORCHESTRATOR_CONFIG.scratchpadRoot
		}
	} catch {
		return { ...DEFAULT_ORCHESTRATOR_CONFIG }
	}
}
