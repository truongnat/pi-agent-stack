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
	stdin?: string | Buffer
	env?: NodeJS.ProcessEnv
	onLine: LineHandler
}): Promise<{ code: number | null; timedOut: boolean; aborted: boolean; stderr: string }> {
	const env = allowlistEnv({ ...process.env, ...(request.env ?? {}) })
	if (request.signal?.aborted) return { code: null, timedOut: false, aborted: true, stderr: '' }
	return await new Promise((resolve) => {
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env,
			stdio: [request.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
		})
		if (request.stdin !== undefined && child.stdin) {
			// EPIPE when the CLI exits before reading stdin; the exit code already reports the failure.
			child.stdin.on('error', () => undefined)
			child.stdin.end(request.stdin)
		}
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
			request.signal?.removeEventListener('abort', onAbort)
			if (buffer.trim()) request.onLine(buffer)
			resolve({
				code,
				timedOut,
				aborted,
				stderr: redact(stderr.slice(0, 20_000))
			})
		}

		const stop = () => {
			child.kill('SIGTERM')
			setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
		}
		const timer = setTimeout(() => {
			timedOut = true
			stop()
		}, request.timeoutMs)

		const onAbort = () => {
			aborted = true
			stop()
		}
		request.signal?.addEventListener('abort', onAbort, { once: true })

		// String decoding keeps multi-byte characters split across chunks intact.
		child.stdout?.setEncoding('utf8')
		child.stderr?.setEncoding('utf8')
		child.stdout?.on('data', (text: string) => {
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
		child.stderr?.on('data', (text: string) => {
			if (stderr.length < 20_000) stderr += text
		})
		child.on('error', (err) => {
			stderr = diagnostic(err.message)
			finish(null)
		})
		child.on('close', (code) => finish(code))
	})
}
