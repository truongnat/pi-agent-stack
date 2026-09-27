import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildPiWorkerArgs,
	describeIdleTimeout,
	formatActivityMarkdown,
	shellJoin,
	SubagentManager
} from '../src/manager.ts'
import type { SubagentTask } from '../src/types.ts'

test('SubagentManager spawns, executes, and tracks subagents in scratchpads', async () => {
	const manager = new SubagentManager()
	const task: SubagentTask = {
		role: 'researcher',
		prompt: 'Survey repository architecture',
		name: 'arch-research'
	}

	const result = await manager.spawnSubagent(task, process.cwd())

	assert.match(result.name, / - Researcher - Senior - \(.+\)$/)
	assert.equal(result.role, 'researcher')
	assert.equal(result.status, 'completed')
	assert.ok(result.durationMs >= 0)
	assert.ok(result.tokensUsed > 0)
	assert.ok(result.output.length > 0)

	const sub = manager.getSubagent(result.id)
	assert.ok(sub)
	assert.equal(sub.status, 'completed')
	assert.ok(sub.logs.length > 0)
})

test('SubagentManager invokeBatch supports parallel and sequential modes', async () => {
	const manager = new SubagentManager()
	const tasks: SubagentTask[] = [
		{ role: 'researcher', prompt: 'Check module 1' },
		{ role: 'tester', prompt: 'Run tests' }
	]

	const parallelResults = await manager.invokeBatch(tasks, process.cwd(), true)
	assert.equal(parallelResults.length, 2)
	assert.equal(parallelResults[0].status, 'completed')
	assert.equal(parallelResults[1].status, 'completed')

	const seqResults = await manager.invokeBatch(tasks, process.cwd(), false)
	assert.equal(seqResults.length, 2)
	assert.equal(seqResults[0].status, 'completed')
	assert.equal(seqResults[1].status, 'completed')
})

test('SubagentManager kill and killAll operations', async () => {
	const manager = new SubagentManager()

	// Spawn a task
	const result = await manager.spawnSubagent({ role: 'coder', prompt: 'Long edit' }, process.cwd())
	const sub = manager.getSubagent(result.id)
	assert.ok(sub)

	// Simulate running
	sub.status = 'running'
	const killed = manager.killSubagent(result.id)
	assert.equal(killed, true)
	assert.equal(sub.status, 'killed')

	// Kill all
	sub.status = 'running'
	const count = manager.killAll()
	assert.equal(count, 1)
	assert.equal(sub.status, 'killed')
})

test('describeIdleTimeout explains empty stream vs quota', () => {
	const empty = describeIdleTimeout({
		idleSec: 180,
		elapsedSec: 180,
		model: 'openai-codex/gpt-5.5'
	})
	assert.match(empty, /model=openai-codex\/gpt-5\.5/)
	assert.match(empty, /never streamed/)

	const silentAfterWork = describeIdleTimeout({
		idleSec: 180,
		elapsedSec: 287,
		model: 'openai-codex/gpt-5.5',
		stdout: '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta"}}'
	})
	assert.match(silentAfterWork, /Stream went silent after progress/)
	assert.doesNotMatch(silentAfterWork, /Worker reported quota/)

	const quota = describeIdleTimeout({
		idleSec: 180,
		elapsedSec: 200,
		model: 'antigravity/gemini-3.1-pro-high',
		stderr: 'API error: RESOURCE_EXHAUSTED (code 429): Individual quota reached'
	})
	assert.match(quota, /quota\/rate-limit/)
})

test('buildPiWorkerArgs uses a session dir so SoL-Pi can start', () => {
	const args = buildPiWorkerArgs({
		model: 'antigravity/gemini-3.8-flash-high',
		sessionDir: '/tmp/scratch/pi-session',
		tools: ['read', 'grep'],
		prompt: 'hello'
	})
	assert.equal(args.includes('--no-session'), false)
	const dirAt = args.indexOf('--session-dir')
	assert.ok(dirAt >= 0)
	assert.equal(args[dirAt + 1], '/tmp/scratch/pi-session')
	assert.ok(args.includes('--mode'))
	assert.ok(args.includes('antigravity/gemini-3.8-flash-high'))
})

test('shellJoin quotes argv for spawnSupervised', () => {
	assert.equal(shellJoin('agy', ['-p', "it's"]), `'agy' '-p' 'it'\\''s'`)
})

test('formatActivityMarkdown is list markdown with elapsed time', () => {
	const md = formatActivityMarkdown(12, ['💭 plan', '▶ read `foo.ts`'])
	assert.match(md, /\*12s\*/)
	assert.match(md, /- 💭 plan/)
	assert.match(md, /- ▶ read/)
})
