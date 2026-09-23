#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const agentDir = process.env.PI_CODING_AGENT_DIR
if (!agentDir) throw new Error('PI_CODING_AGENT_DIR is required')

const settingsPath = join(agentDir, 'settings.json')
mkdirSync(agentDir, { recursive: true })

let settings = {}
try {
	settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
} catch {
	// A fresh Pi install has no settings file yet.
}

const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry?.source ?? '')
const removeManaged = (entry) => {
	const source = sourceOf(entry)
	return (
		source.startsWith('git:github.com/MoonTory/pi-jev-harness') ||
		source === 'pi-subscription-providers' ||
		source.includes('/pi-agent-stack/packages/pi-jev-harness') ||
		source.includes('/pi-agent-stack/packages/pi-subscription-providers') ||
		source.startsWith('npm:@davecodes/pi-dcp')
	)
}

const packages = Array.isArray(settings.packages) ? settings.packages.filter((entry) => !removeManaged(entry)) : []
packages.push(
	'./pi-agent-stack/packages/pi-jev-harness',
	'./pi-agent-stack/packages/pi-subscription-providers',
	'npm:@davecodes/pi-dcp@0.2.0'
)

const next = {
	...settings,
	defaultProvider: 'openai-codex',
	defaultModel: 'gpt-5.6-luna',
	defaultThinkingLevel: 'high',
	packages,
	enableSkillCommands: true,
	showCacheMissNotices: true,
	cacheWarming: 'streaming',
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
		...(settings.compaction ?? {})
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 1500,
		maxAgentDelayMs: 30000,
		provider: { maxRetries: 0 },
		...(settings.retry ?? {}),
		provider: { maxRetries: 0, ...(settings.retry?.provider ?? {}) }
	}
}

writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
console.log(`Synced ${settingsPath}`)