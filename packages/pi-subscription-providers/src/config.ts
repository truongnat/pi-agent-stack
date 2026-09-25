import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ProviderConfig, ProviderId, RootConfig } from './types.ts'

export const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'subscription-providers.json')

export const STATUS_PATH = join(homedir(), '.pi', 'agent', 'subscription-providers-status.json')

const DEFAULT_PROVIDER: ProviderConfig = {
	enabled: true,
	command: 'auto',
	timeoutMs: 120_000,
	maxOutputChars: 200_000,
	readinessTtlMs: 5 * 60_000,
	latencyEstimateMs: 8_000,
	marginalInputCost: 0.15,
	marginalOutputCost: 0.6
}

export const DEFAULT_CONFIG: RootConfig = {
	cursor: { ...DEFAULT_PROVIDER, latencyEstimateMs: 12_000 },
	antigravity: { ...DEFAULT_PROVIDER, latencyEstimateMs: 6_000 },
	'claude-code': { ...DEFAULT_PROVIDER, latencyEstimateMs: 8_000 }
}

export function loadConfig(path = CONFIG_PATH): RootConfig {
	try {
		// SAFETY: user-owned config; unknown keys ignored, missing keys fall back.
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RootConfig>
		return {
			cursor: { ...DEFAULT_CONFIG.cursor, ...(raw.cursor ?? {}) },
			antigravity: { ...DEFAULT_CONFIG.antigravity, ...(raw.antigravity ?? {}) },
			'claude-code': { ...DEFAULT_CONFIG['claude-code'], ...(raw['claude-code'] ?? {}) }
		}
	} catch {
		// Missing or unreadable config → defaults.
		return {
			cursor: { ...DEFAULT_CONFIG.cursor },
			antigravity: { ...DEFAULT_CONFIG.antigravity },
			'claude-code': { ...DEFAULT_CONFIG['claude-code'] }
		}
	}
}

export function providerConfig(config: RootConfig, id: ProviderId): ProviderConfig {
	return config[id]
}
