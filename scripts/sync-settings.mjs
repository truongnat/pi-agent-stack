#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
		source.startsWith('npm:@davecodes/pi-dcp')
	)
}

const packages = Array.isArray(settings.packages) ? settings.packages.filter((entry) => !removeManaged(entry)) : []

// defaultProjectTrust is only a default: a user who chose "untrusted" keeps it, so repos with
// their own .pi/extensions do not start running code on the next install.
const next = {
	defaultProjectTrust: 'trusted',
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
// `mode` only applies when the file is created; tighten an existing one too.
chmodSync(settingsPath, 0o600)
console.log(`Synced ${settingsPath}`)

// Sync Claude Code OAuth credentials to Pi's anthropic provider if present
const claudeCredsPath = join(process.env.HOME || '', '.claude', '.credentials.json')
try {
	const claudeCreds = JSON.parse(readFileSync(claudeCredsPath, 'utf8'))
	if (claudeCreds?.claudeAiOauth?.accessToken && claudeCreds?.claudeAiOauth?.refreshToken) {
		const authPath = join(agentDir, 'auth.json')
		let auth = {}
		try {
			auth = JSON.parse(readFileSync(authPath, 'utf8'))
		} catch {
			// No auth file yet
		}
		// Seed only: an Anthropic login or key the user set up for Pi is not replaced.
		if (!auth.anthropic) {
			auth.anthropic = {
				type: 'oauth',
				access: claudeCreds.claudeAiOauth.accessToken,
				refresh: claudeCreds.claudeAiOauth.refreshToken,
				expires: claudeCreds.claudeAiOauth.expiresAt
			}
			writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
			console.log(`Seeded Anthropic login in ${authPath} from Claude Code`)
		}
		chmodSync(authPath, 0o600)
	}
} catch {
	// Claude credentials not found or unreadable, ignore
}