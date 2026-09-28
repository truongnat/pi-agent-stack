import assert from 'node:assert/strict'
import test from 'node:test'

import { planDag, promptWithDependencies, renderDag } from '../src/dag.ts'
import type { SubagentExecutionResult } from '../src/types.ts'

const task = (id: string, dependsOn: string[] = []) => ({
	id,
	role: 'coder',
	prompt: `do ${id}`,
	dependsOn
})

test('planDag validates ids, dependencies and cycles', () => {
	assert.ok('nodes' in planDag([task('a'), task('b', ['a'])]))
	assert.match((planDag([task('a'), task('a')]) as { error: string }).error, /Duplicate/)
	assert.match((planDag([task('a', ['zzz'])]) as { error: string }).error, /unknown id/)
	assert.match((planDag([task('a', ['a'])]) as { error: string }).error, /itself/)
	const cycle = planDag([task('a', ['c']), task('b', ['a']), task('c', ['b']), task('d')])
	assert.match((cycle as { error: string }).error, /cycle between: a, b, c/)
	const auto = planDag([
		{ role: 'coder', prompt: 'x' },
		{ role: 'tester', prompt: 'y', dependsOn: ['t1'] }
	])
	assert.deepEqual('nodes' in auto ? auto.nodes.map((n) => n.id) : [], ['t1', 't2'])
})

test('dependent prompts carry the dependency outputs, clipped', () => {
	const done = new Map<string, SubagentExecutionResult>([
		[
			'a',
			{
				id: 's1',
				role: 'researcher',
				name: 'r',
				status: 'completed',
				output: 'x'.repeat(5000),
				tokensUsed: 1,
				durationMs: 1,
				scratchpadDir: '/tmp/s1'
			}
		]
	])
	const planned = planDag([task('a'), task('b', ['a'])])
	assert.ok('nodes' in planned)
	const prompt = promptWithDependencies(planned.nodes[1]!, done)
	assert.match(prompt, /^do b/)
	assert.match(prompt, /### a \(researcher\)/)
	assert.match(prompt, /truncated; full output: \/tmp\/s1\/output\.md/)
	assert.equal(promptWithDependencies(planned.nodes[0]!, done), 'do a')
	assert.match(
		renderDag(planned.nodes, new Map([['a', 'completed']])),
		/✓ a \[coder\] completed[\s\S]*· b \[coder\] pending ← a/
	)
})

test('invokeDag runs in dependency order, passes outputs down, skips after a failure', async () => {
	const { fakeManager } = await import('./fake-runner.ts')
	const started: string[] = []
	const { manager } = fakeManager({ maxConcurrentSubagents: 4 }, async (request) => {
		const prompt = request.args.find((a) => a.includes('Task:')) ?? ''
		const id = /do (\w+)/.exec(prompt)?.[1] ?? '?'
		started.push(id)
		if (id === 'bad') return { stdout: '', stderr: 'boom', code: 1 }
		const line = JSON.stringify({
			type: 'message_end',
			message: { role: 'assistant', content: [{ type: 'text', text: `out-${id}` }] }
		})
		request.onChunk?.(`${line}\n`)
		return { stdout: line, stderr: '', code: 0 }
	})
	// diamond a -> (b, c) -> d, plus bad -> never
	const planned = planDag([
		task('a'),
		task('b', ['a']),
		task('c', ['a']),
		task('d', ['b', 'c']),
		{ ...task('bad'), role: 'researcher' },
		task('never', ['bad'])
	])
	assert.ok('nodes' in planned)
	const results = await manager.invokeDag(planned.nodes, process.cwd())
	const byId = new Map(planned.nodes.map((n, i) => [n.id, results[i]]))
	assert.equal(byId.get('d')?.status, 'completed')
	assert.ok(
		started.indexOf('a') < started.indexOf('b') && started.indexOf('a') < started.indexOf('c')
	)
	assert.ok(started.indexOf('d') > Math.max(started.indexOf('b'), started.indexOf('c')))
	assert.equal(byId.get('never')?.status, 'skipped')
	assert.ok(!started.includes('never'))
	assert.match(byId.get('never')?.error ?? '', /dependency "bad" failed/)
	assert.equal(manager.lastDag.status.get('d'), 'completed')
})
