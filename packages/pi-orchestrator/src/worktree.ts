/**
 * Isolated workspaces for write-capable subagents: each runs in its own `git worktree` and
 * hands back a patch instead of editing the user's checkout. Nothing is applied automatically.
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const git = async (cwd: string, ...args: string[]) =>
	(
		await run('git', ['-C', cwd, ...args], {
			maxBuffer: 64 * 1024 * 1024,
			// A throwaway baseline commit needs an identity even when the user has none configured.
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'pi-orchestrator',
				GIT_AUTHOR_EMAIL: 'pi-orchestrator@localhost',
				GIT_COMMITTER_NAME: 'pi-orchestrator',
				GIT_COMMITTER_EMAIL: 'pi-orchestrator@localhost'
			}
		})
	).stdout

export interface Worktree {
	/** Where the worker runs: the worktree path matching the caller's cwd. */
	cwd: string
	/** Collects the worker's changes as a patch, removes the worktree, returns the summary. */
	finish(): Promise<{ patchPath: string; files: string[] }>
}

/**
 * Starts from the user's current state: HEAD plus their uncommitted tracked changes, recorded as
 * a baseline commit inside the worktree so the patch holds only what the worker changed.
 * Untracked files of the user are not copied.
 */
export async function createWorktree(cwd: string, scratchpadDir: string): Promise<Worktree> {
	let top: string
	try {
		top = (await git(cwd, 'rev-parse', '--show-toplevel')).trim()
	} catch {
		throw new Error(
			`isolate_workspace needs a git repository, and ${cwd} is not in one. Run without it or init git.`
		)
	}
	const dir = join(scratchpadDir, 'worktree')
	await git(top, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD')
	const pending = await git(top, 'diff', 'HEAD', '--binary')
	if (pending.trim()) {
		const baseline = join(scratchpadDir, 'baseline.patch')
		writeFileSync(baseline, pending)
		await git(dir, 'apply', '--whitespace=nowarn', baseline)
	}
	await git(dir, 'add', '-A')
	await git(
		dir,
		'commit',
		'--quiet',
		'--allow-empty',
		'--no-verify',
		'-m',
		'pi-orchestrator baseline'
	)

	return {
		cwd: join(dir, relative(top, cwd)),
		async finish() {
			try {
				await git(dir, 'add', '-A')
				const patch = await git(dir, 'diff', '--cached', '--binary', 'HEAD')
				const files = (await git(dir, 'diff', '--cached', '--name-only', 'HEAD'))
					.split('\n')
					.filter(Boolean)
				const patchPath = join(scratchpadDir, 'changes.patch')
				writeFileSync(patchPath, patch)
				return { patchPath, files }
			} finally {
				await git(top, 'worktree', 'remove', '--force', dir).catch(() => undefined)
			}
		}
	}
}
