import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import type { Runner } from './types.ts'

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

export function which(name: string, pathEnv = process.env.PATH ?? ''): string | undefined {
	if (isAbsolute(name) && isExecutable(name)) return name
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue
		const candidate = join(dir, name)
		if (isExecutable(candidate)) return candidate
	}
	return undefined
}

/** Cursor Agent CLI — never treat bare `agent` as Cursor without a fingerprint. */
export async function resolveCursorCommand(
	configured: string,
	runner: Runner
): Promise<{ command?: string; reason: string }> {
	if (configured !== 'auto') {
		const path = isAbsolute(configured) ? configured : which(configured)
		if (!path) return { reason: `configured command not found: ${configured}` }
		const ok = await fingerprintCursor(path, runner)
		return ok
			? { command: path, reason: 'configured command verified' }
			: { reason: `configured command is not Cursor Agent CLI: ${configured}` }
	}
	for (const name of ['cursor-agent', 'agent']) {
		const path = which(name)
		if (!path) continue
		if (await fingerprintCursor(path, runner)) {
			return { command: path, reason: `found ${name}` }
		}
	}
	return { reason: 'Cursor Agent CLI not found (tried cursor-agent, agent)' }
}

async function fingerprintCursor(command: string, runner: Runner): Promise<boolean> {
	const result = await runner({
		command,
		args: ['--help'],
		timeoutMs: 8_000,
		maxOutputChars: 8_000
	})
	const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
	if (text.includes('grok build') || text.includes('grok ')) return false
	return (
		text.includes('cursor agent') ||
		text.includes('--list-models') ||
		text.includes('output-format') ||
		text.includes('stream-json')
	)
}

/** Antigravity: prefer ACP binary if present, else agy. */
export async function resolveAntigravityCommand(
	configured: string,
	runner: Runner
): Promise<{ command?: string; interface: 'acp' | 'agy' | 'none'; reason: string }> {
	if (configured !== 'auto') {
		const path = isAbsolute(configured) ? configured : which(configured)
		if (!path) return { interface: 'none', reason: `configured command not found: ${configured}` }
		const iface = await fingerprintAntigravity(path, runner)
		return iface === 'none'
			? { interface: 'none', reason: `configured command is not Antigravity CLI: ${configured}` }
			: { command: path, interface: iface, reason: `configured ${iface}` }
	}
	for (const name of ['agy']) {
		const path = which(name)
		if (!path) continue
		const iface = await fingerprintAntigravity(path, runner)
		if (iface === 'agy') {
			return { command: path, interface: iface, reason: `found ${name} (${iface})` }
		}
	}
	return {
		interface: 'none',
		reason:
			'Antigravity CLI not found (agy). ACP binaries are detected but not used until an ACP stream adapter ships.'
	}
}

async function fingerprintAntigravity(
	command: string,
	runner: Runner
): Promise<'acp' | 'agy' | 'none'> {
	const base = command.split('/').pop() ?? command
	if (base.includes('acp')) {
		const result = await runner({
			command,
			args: ['--help'],
			timeoutMs: 8_000,
			maxOutputChars: 8_000
		})
		const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
		if (text.includes('acp') || text.includes('agent client protocol')) return 'acp'
	}
	const result = await runner({
		command,
		args: ['--help'],
		timeoutMs: 8_000,
		maxOutputChars: 8_000
	})
	const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
	if (
		text.includes('usage of agy') ||
		text.includes('--output-format') ||
		text.includes('stream-json')
	) {
		return 'agy'
	}
	return 'none'
}