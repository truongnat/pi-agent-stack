import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fakeManager } from './fake-runner.ts'

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'wt-repo-'))
	const git = (...args: string[]) =>
		execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
	git('init', '-q')
	writeFileSync(join(dir, 'a.txt'), 'one\n')
	git('add', '.')
	git('commit', '-qm', 'init')
	// An uncommitted edit of the user's, which the worker must start from but not re-report.
	writeFileSync(join(dir, 'a.txt'), 'one\nuser edit\n')
	return dir
}

test('isolated coders edit a worktree and return a patch; the checkout is untouched', async () => {
	const dir = repo()
	let workerCwd = ''
	const { manager } = fakeManager({}, async (request) => {
		workerCwd = request.cwd
		assert.match(readFileSync(join(request.cwd, 'a.txt'), 'utf8'), /user edit/)
		writeFileSync(join(request.cwd, 'b.txt'), 'from worker\n')
		const line = JSON.stringify({
			type: 'message_end',
			message: { role: 'assistant', content: [{ type: 'text', text: 'added b.txt' }] }
		})
		request.onChunk?.(`${line}\n`)
		return { stdout: line, stderr: '', code: 0 }
	})
	const result = await manager.spawnSubagent(
		{ role: 'coder', prompt: 'add b', isolateWorkspace: true },
		dir
	)
	assert.equal(result.status, 'completed')
	assert.notEqual(workerCwd, dir)
	assert.equal(existsSync(join(dir, 'b.txt')), false, 'checkout untouched')
	assert.equal(existsSync(workerCwd), false, 'worktree removed')
	const patch = readFileSync(join(result.scratchpadDir, 'changes.patch'), 'utf8')
	assert.match(patch, /b\.txt/)
	assert.doesNotMatch(patch, /user edit/, 'baseline not re-reported')
	assert.match(result.output, /git apply .*changes\.patch/)
	execFileSync('git', ['-C', dir, 'apply', join(result.scratchpadDir, 'changes.patch')])
	assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'from worker\n')
})

test('isolate_workspace outside a git repo fails clearly', async () => {
	const { manager } = fakeManager()
	const result = await manager.spawnSubagent(
		{ role: 'coder', prompt: 'x', isolateWorkspace: true },
		mkdtempSync(join(tmpdir(), 'no-git-'))
	)
	assert.equal(result.status, 'failed')
	assert.match(result.error ?? '', /needs a git repository/)
})
