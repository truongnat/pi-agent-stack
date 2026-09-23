import { spawn } from 'node:child_process'

import { allowlistEnv } from './env.ts'
import { diagnostic, redact } from './redact.ts'

export type LineHandler = (line: string) => void

export async function runStreamingLines(request: {
	command: string
	args: string[]
	cwd?: string
	timeoutMs: number
	maxOutputChars: number
	signal?: AbortSignal
	onLine: LineHandler
}): Promise<{ code: number | null; timedOut: boolean; aborted: boolean; stderr: string }> {
	const env = allowlistEnv()
	return await new Promise((resolve) => {
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		})
		let stderr = ''
		let stdoutChars = 0
		let timedOut = false
		let aborted = false
		let settled = false
		let buffer = ''

		const finish = (code: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (buffer.trim()) request.onLine(buffer)
			resolve({
				code,
				timedOut,
				aborted,
				stderr: redact(stderr.slice(0, 20_000))
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
			const text = chunk.toString('utf8')
			stdoutChars += text.length
			if (stdoutChars > request.maxOutputChars) {
				child.kill('SIGTERM')
				return
			}
			buffer += text
			const lines = buffer.split(/\r?\n/)
			buffer = lines.pop() ?? ''
			for (const line of lines) {
				if (line.trim()) request.onLine(line)
			}
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length < 20_000) stderr += chunk.toString('utf8')
		})
		child.on('error', (err) => {
			stderr = diagnostic(err.message)
			finish(null)
		})
		child.on('close', (code) => finish(code))
	})
}