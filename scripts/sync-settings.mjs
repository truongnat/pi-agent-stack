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

const defaultsPath = join(agentDir, 'pi-agent-stack/config/pi-defaults.json')
let defaults = {}
try {
	defaults = JSON.parse(readFileSync(defaultsPath, 'utf8'))
} catch {
	// No defaults file found
}

const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry?.source ?? '')
const removeManaged = (entry) => {
	const source = sourceOf(entry)
	return (
		source.startsWith('git:github.com/MoonTory/pi-jev-harness') ||
		source === 'pi-subscription-providers' ||
		source === 'pi-rl-engine' ||
		source.includes('/pi-agent-stack/packages/pi-jev-harness') ||
		source.includes('/pi-agent-stack/packages/pi-subscription-providers') ||
		source.includes('/pi-agent-stack/packages/pi-rl-engine') ||
		source.startsWith('npm:@davecodes/pi-dcp') ||
		source.startsWith('npm:pi-continuous-learning')
	)
}

const packages = Array.isArray(settings.packages) ? settings.packages.filter((entry) => !removeManaged(entry)) : []
packages.push(
	'./pi-agent-stack/packages/pi-jev-harness',
	'./pi-agent-stack/packages/pi-subscription-providers',
	'./pi-agent-stack/packages/pi-rl-engine',
	'npm:@davecodes/pi-dcp@0.2.0',
	'npm:pi-continuous-learning@0.14.4'
)

const next = {
	...defaults,
	...settings,
	packages,
	compaction: {
		...(defaults.compaction ?? {}),
		...(settings.compaction ?? {})
	},
	retry: {
		...(defaults.retry ?? {}),
		...(settings.retry ?? {}),
		provider: {
			...(defaults.retry?.provider ?? {}),
			...(settings.retry?.provider ?? {})
		}
	}
}

writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })

console.log(`Synced ${settingsPath}`)