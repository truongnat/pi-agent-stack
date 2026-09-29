import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildPiWorkerArgs,
	describeIdleTimeout,
	formatActivityText,
	isTimeoutOrCapStderr,
	isUnsupportedModelStderr,
	shellJoin,
	SubagentManager
} from '../src/manager.ts'
import { createOrchestratorTools } from '../src/tools.ts'
import type { SubagentTask } from '../src/types.ts'
import { fakeManager, piReply } from './fake-runner.ts'

test('SubagentManager spawns, executes, and tracks subagents in scratchpads', async () => {
	const manager = fakeManager().manager
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
	const manager = fakeManager().manager
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

test('startBatch returns immediately and retains final results for later inspection', async () => {
	let markStarted = () => {}
	let releaseWorker = () => {}
	const started = new Promise<void>((resolve) => {
		markStarted = resolve
	})
	const gate = new Promise<void>((resolve) => {
		releaseWorker = resolve
	})
	const { manager } = fakeManager({}, async (request) => {
		markStarted()
		await gate
		return await piReply('done')(request)
	})
	const run = manager.startBatch((signal, onProgress) =>
		manager.invokeBatch(
			[{ role: 'researcher', prompt: 'Inspect one module' }],
			process.cwd(),
			true,
			{ signal, onProgress }
		)
	)

	await started
	assert.equal(run.status, 'running')
	assert.equal(manager.getBatch(run.id)?.status, 'running')
	assert.equal(manager.getBatch(run.id)?.subagentIds.length, 1)

	releaseWorker()
	const completed = await manager.waitBatch(run.id)
	assert.equal(completed?.status, 'completed')
	assert.equal(completed?.results[0]?.output, 'done')
})

test('spawnSubagent fails when requested tools are outside the role allowlist', async () => {
	const manager = fakeManager().manager
	const result = await manager.spawnSubagent(
		{ role: 'researcher', prompt: 'Survey', tools: ['read', 'write'] },
		process.cwd()
	)
	assert.equal(result.status, 'failed')
	assert.match(result.error ?? '', /cannot use tools: write/)
	assert.equal(manager.getSubagent(result.id)?.status, 'failed')
})

test('SubagentManager kill and killAll operations', async () => {
	const manager = fakeManager().manager

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

test('isTimeoutOrCapStderr catches both the CLI wording and the orchestrator hard cap', () => {
	assert.equal(isTimeoutOrCapStderr('antigravity timed out after 120000ms'), true)
	assert.equal(isTimeoutOrCapStderr('Process reached maximum execution limit of 180s'), true)
	assert.equal(isTimeoutOrCapStderr('boom: unrelated crash'), false)
})

test('buildPiWorkerArgs uses a session dir so SoL-Pi can start', () => {
	const args = buildPiWorkerArgs({
		model: 'antigravity/gemini-3.8-flash-high',
		sessionDir: '/tmp/scratch/pi-session',
		tools: ['read', 'grep']
	})
	assert.equal(args.includes('--no-session'), false)
	const dirAt = args.indexOf('--session-dir')
	assert.ok(dirAt >= 0)
	assert.equal(args[dirAt + 1], '/tmp/scratch/pi-session')
	assert.equal(args[args.indexOf('--mode') + 1], 'rpc')
	assert.ok(args.includes('antigravity/gemini-3.8-flash-high'))
})

test('shellJoin quotes argv for spawnSupervised', () => {
	assert.equal(shellJoin('agy', ['-p', "it's"]), `'agy' '-p' 'it'\\''s'`)
})

test('formatActivityText is elapsed time plus indented trail', () => {
	const text = formatActivityText(12, ['💭 plan', '▶ read `foo.ts`'])
	assert.match(text, /^12s\n/)
	assert.match(text, /  💭 plan/)
	assert.match(text, /  ▶ read/)
	assert.equal(text.includes('*12s*'), false)
})

test('Esc stops the subagent: no model retry and no fallback CLIs after an abort', async () => {
	const controller = new AbortController()
	const { manager, calls } = fakeManager({}, async () => {
		controller.abort()
		return { stdout: '', stderr: 'Aborted by signal', code: -1 }
	})
	const result = await manager.spawnSubagent({ role: 'coder', prompt: 'x' }, process.cwd(), {
		signal: controller.signal
	})
	assert.equal(calls.length, 1)
	assert.equal(result.status, 'failed')
	assert.match(result.error ?? '', /aborted/i)
})

test('/agents kill stays killed: no fallback and no "completed" overwrite', async () => {
	let id = ''
	const { manager, calls } = fakeManager({}, async (request) => {
		id = request.instance?.id ?? ''
		manager.killSubagent(id)
		return { stdout: '', stderr: '', code: null }
	})
	const result = await manager.spawnSubagent({ role: 'coder', prompt: 'x' }, process.cwd())
	assert.equal(calls.length, 1)
	assert.equal(result.status, 'killed')
	assert.equal(manager.getSubagent(id)?.status, 'killed')
})

test('read-only roles fall back only to a read-only CLI', async () => {
	const { manager, calls } = fakeManager({}, async () => ({ stdout: '', stderr: 'boom', code: 1 }))
	await manager.spawnSubagent({ role: 'reviewer', prompt: 'x' }, process.cwd())
	assert.deepEqual(
		calls.map((c) => c.command),
		['pi', 'claude']
	)
	assert.ok(!calls.some((c) => c.args.includes('--dangerously-skip-permissions')))
	assert.ok(calls[1]?.args.includes('plan'))
})

test('token usage comes from the worker stream', async () => {
	const { manager } = fakeManager({}, piReply('done', { input: 1000, output: 200 }))
	const result = await manager.spawnSubagent({ role: 'researcher', prompt: 'x' }, process.cwd())
	assert.equal(result.tokensUsed, 1200)
})

test('clearHistory keeps running subagents so they can still be killed', async () => {
	let release: () => void = () => undefined
	const { manager } = fakeManager(
		{},
		(request) =>
			new Promise((resolve) => {
				release = () => piReply('ok')(request).then(resolve)
			})
	)
	const pending = manager.spawnSubagent({ role: 'coder', prompt: 'x' }, process.cwd())
	await new Promise((r) => setTimeout(r, 10))
	manager.clearHistory()
	assert.equal(manager.listSubagents().length, 1)
	release()
	await pending
	manager.clearHistory()
	assert.equal(manager.listSubagents().length, 0)
})

test('workers always run regex-only Jev (no UI to confirm)', async () => {
	const { manager, calls } = fakeManager()
	await manager.spawnSubagent({ role: 'coder', prompt: 'x' }, process.cwd())
	assert.equal(calls[0]?.env?.PI_SUBAGENT_WORKER, '1')
	assert.equal(calls[0]?.env?.PI_JEV_REGEX_ONLY, '1')
})

test('isUnsupportedModelStderr matches ChatGPT Codex model rejection', () => {
	assert.equal(
		isUnsupportedModelStderr(
			"Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."
		),
		true
	)
	assert.equal(isUnsupportedModelStderr('HTTP 429 quota reached'), false)
})

test('unsupported model on the first pi worker retries a different model', async () => {
	let n = 0
	const { manager, calls } = fakeManager({}, async (request) => {
		n++
		if (n === 1) {
			return {
				stdout: '',
				stderr:
					"Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
				code: 1
			}
		}
		return piReply('recovered')(request)
	})
	const result = await manager.spawnSubagent({ role: 'tester', prompt: 'x' }, process.cwd())
	assert.equal(result.status, 'completed')
	assert.ok(calls.length >= 2)
	assert.equal(calls[0]?.command, 'pi')
	assert.equal(calls[1]?.command, 'pi')
	const firstModel = calls[0]?.args[calls[0].args.indexOf('--model') + 1]
	const secondModel = calls[1]?.args[calls[1].args.indexOf('--model') + 1]
	if (firstModel && secondModel && firstModel !== 'default') {
		assert.notEqual(secondModel, firstModel)
	}
})

test('fallback CLIs get the full timeout before their first byte', async () => {
	const { manager, calls } = fakeManager({}, async () => ({ stdout: '', stderr: 'boom', code: 1 }))
	await manager.spawnSubagent({ role: 'coder', prompt: 'x' }, process.cwd())
	assert.equal(calls[0]?.firstByteTimeoutMs, undefined)
	assert.ok(calls.slice(1).every((c) => c.firstByteTimeoutMs === 600_000))
})

test('send_subagent_message steers the running worker over RPC', async () => {
	const sent: object[] = []
	let release: () => void = () => undefined
	const { manager } = fakeManager(
		{},
		(request) =>
			new Promise((resolve) => {
				request.rpc?.onSend((cmd) => {
					sent.push(cmd)
					return true
				})
				release = () => {
					request.rpc?.onSend(undefined)
					void piReply('done')(request).then(resolve)
				}
			})
	)
	const { sendSubagentMessageTool } = createOrchestratorTools(manager)
	const pending = manager.spawnSubagent({ role: 'coder', prompt: 'x' }, process.cwd())
	await new Promise((r) => setTimeout(r, 10))
	const id = manager.listSubagents()[0]!.id
	const res = await sendSubagentMessageTool.execute(
		'1',
		{ subagent_id: id, message: 'use pnpm' },
		new AbortController().signal,
		() => {},
		{} as never
	)
	assert.deepEqual(sent, [{ type: 'steer', message: 'use pnpm' }])
	assert.match(JSON.stringify(res.content), /steer/i)
	release()
	await pending
	const late = await sendSubagentMessageTool.execute(
		'2',
		{ subagent_id: id, message: 'too late' },
		new AbortController().signal,
		() => {},
		{} as never
	)
	assert.match(JSON.stringify(late.content), /not running/i)
	assert.equal(sent.length, 1)
})
