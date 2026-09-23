import { spawn } from 'node:child_process'

import { allowlistEnv } from './env.ts'
import { diagnostic, redact } from './redact.ts'
import type { Runner, RunResult } from './types.ts'

function truncate(text: string, max: number): string {
	if (text.length <= max) return text
	return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

export const defaultRunner: Runner = async (request) => {
	const started = performance.now()
	const env = allowlistEnv({ ...process.env, ...(request.env ?? {}) })
	return await new Promise<RunResult>((resolve) => {
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env,
			stdio: request.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
		})
		let stdout = ''
		let stderr = ''
		let timedOut = false
		let aborted = false
		let settled = false

		const finish = (code: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve({
				code,
				stdout: redact(truncate(stdout, request.maxOutputChars)),
				stderr: redact(truncate(stderr, Math.min(request.maxOutputChars, 20_000))),
				timedOut,
				aborted,
				durationMs: Math.round(performance.now() - started)
			})
		}

		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGTERM')
			setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
		}, request.timeoutMs)

		const onAbort = () => {
			aborted = true
			child.kill('SIGTERM')
		}
		request.signal?.addEventListener('abort', onAbort, { once: true })

		child.stdout?.on('data', (chunk: Buffer) => {
			if (stdout.length < request.maxOutputChars + 1) stdout += chunk.toString('utf8')
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length < request.maxOutputChars + 1) stderr += chunk.toString('utf8')
		})
		child.on('error', (err) => {
			stderr = diagnostic(err.message)
			finish(null)
		})
		child.on('close', (code) => finish(code))

		if (request.stdin !== undefined && child.stdin) {
			child.stdin.end(request.stdin)
		}
	})
}

export function mapRunError(result: RunResult, label: string): string {
	if (result.aborted) return `${label}: aborted`
	if (result.timedOut) return `${label}: timed out after ${result.durationMs}ms`
	if (result.code === null)
		return `${label}: failed to start (${diagnostic(result.stderr) || 'unknown'})`
	if (result.code !== 0) {
		const detail = diagnostic(result.stderr) || diagnostic(result.stdout) || `exit ${result.code}`
		return `${label}: ${detail}`
	}
	return `${label}: ok`
}
