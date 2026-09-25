/**
 * Lossless trimming: when JEV cuts a tool result, the full text is saved to a private file
 * and the model is told where it is, so it can read the rest instead of re-running the call.
 * Pattern from deepseek-harness packages/spill (MIT).
 */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SPILL_DIR = join(homedir(), '.jev-harness', 'spill')

/** Spill files older than this are removed. */
const MAX_AGE_MS = 24 * 60 * 60_000

/** At most this many spill files are kept (newest first). */
const MAX_FILES = 200

/** Drop old spill files; never throws. */
export function pruneSpills(dir = SPILL_DIR, now = Date.now()): void {
	try {
		const files = readdirSync(dir)
			.filter((name) => name.endsWith('.txt'))
			.map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
			.toSorted((a, b) => b.mtime - a.mtime)
		files.forEach((file, index) => {
			if (index >= MAX_FILES || now - file.mtime > MAX_AGE_MS) rmSync(file.path, { force: true })
		})
	} catch {
		// Cleanup is best effort.
	}
}

/**
 * Write the full output to a new owner-only file and return its path, or undefined when it
 * cannot be saved (the caller then keeps its lossy message). `wx` refuses to follow a planted
 * file or symlink with the same name.
 */
export function spill(text: string, tool: string, dir = SPILL_DIR): string | undefined {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		pruneSpills(dir)
		const safeTool = tool.replace(/[^a-z0-9_-]/gi, '_').slice(0, 32)
		const path = join(dir, `${Date.now()}-${safeTool}-${randomBytes(4).toString('hex')}.txt`)
		const fd = openSync(path, 'wx', 0o600)
		try {
			writeSync(fd, text)
		} finally {
			closeSync(fd)
		}
		return path
	} catch {
		return undefined
	}
}

/** How the model can get the rest back. */
export function spillHint(path: string): string {
	return `Full output saved at ${path}; read it with the read tool (offset/limit) or grep it instead of re-running.`
}
