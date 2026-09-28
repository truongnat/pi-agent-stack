import { mkdirSync, rmdirSync, statSync } from 'node:fs'

const LOCK_STALE_MS = 30_000
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Serializes read-modify-write access to `file` across processes: several `pi` processes can
 * share the same lessons/Q-table file (an orchestrator subagent is a separate `pi` process from
 * the main session), so a write must not silently clobber a concurrent writer's change. Losers
 * queue (50ms retry) up to a 10s deadline, then report busy (throw) rather than corrupt the
 * file or hang forever. Same idiom as pi-subscription-providers/src/accounts.ts's account-store
 * lock: an `<file>.lock` directory (mkdir is atomic test-and-set), stale after 30s in case a
 * process died holding it.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
	const lock = `${file}.lock`
	const deadline = Date.now() + 10_000
	for (;;) {
		try {
			mkdirSync(lock)
			break
		} catch (error) {
			if ((error as { code?: string }).code !== 'EEXIST') throw error
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock)
			} catch {
				// Lock vanished between checks; retry.
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`, { cause: error })
			sleepSync(50)
		}
	}
	try {
		return fn()
	} finally {
		rmdirSync(lock)
	}
}
