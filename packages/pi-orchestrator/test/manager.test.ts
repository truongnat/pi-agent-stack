import assert from 'node:assert/strict'
import test from 'node:test'
import { SubagentManager } from '../src/manager.ts'
import type { SubagentTask } from '../src/types.ts'

test('SubagentManager spawns, executes, and tracks subagents in scratchpads', async () => {
	const manager = new SubagentManager()
	const task: SubagentTask = {
		role: 'researcher',
		prompt: 'Survey repository architecture',
		name: 'arch-research'
	}

	const result = await manager.spawnSubagent(task, process.cwd())

	assert.equal(result.name, 'arch-research')
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
