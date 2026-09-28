import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEndEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createGoalExtension, restoreGoal } from '../src/extension.ts'

type Reply = Extract<AgentEndEvent['messages'][number], { role: 'assistant' }>

/** An agent_end exactly as Pi 0.87 emits it: usage and stop reason live on each reply. */
function agentEnd(
	replies: Array<{
		input: number
		output: number
		stopReason?: Reply['stopReason']
		error?: string
	}>
): AgentEndEvent {
	const messages = replies.map((r): Reply => ({
		role: 'assistant',
		content: [{ type: 'text', text: 'working' }],
		api: 'anthropic-messages',
		provider: 'anthropic',
		model: 'test',
		usage: {
			input: r.input,
			output: r.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: r.input + r.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		},
		stopReason: r.stopReason ?? 'stop',
		...(r.error ? { errorMessage: r.error } : {}),
		timestamp: 0
	}))
	return { type: 'agent_end', messages } satisfies AgentEndEvent
}

function createMockPi() {
	const listeners: Record<string, Function[]> = {}
	const commands: Record<string, any> = {}
	const tools: Record<string, any> = {}
	const shortcuts: Record<string, any> = {}
	const customEntries: any[] = []
	const sentMessages: string[] = []
	const sentOptions: Array<{ deliverAs?: string } | undefined> = []

	const pi = {
		on(event: string, handler: Function) {
			listeners[event] = listeners[event] || []
			listeners[event].push(handler)
		},
		registerCommand(name: string, def: any) {
			commands[name] = def
		},
		registerTool(tool: any) {
			tools[tool.name] = tool
		},
		registerShortcut(key: string, def: any) {
			shortcuts[key] = def
		},
		registerMessageRenderer(_type: string, _renderer: any) {
			// no-op in tests
		},
		registerEntryRenderer(_type: string, _renderer: any) {
			// no-op in tests
		},
		appendEntry(type: string, data: any) {
			customEntries.push({ type, data })
		},
		sendUserMessage(msg: string, opts?: { deliverAs?: string }) {
			sentMessages.push(msg)
			sentOptions.push(opts)
		}
	} as unknown as ExtensionAPI

	return { pi, listeners, commands, tools, shortcuts, customEntries, sentMessages, sentOptions }
}

test('createGoalExtension registers tools and /goal command', () => {
	const mock = createMockPi()
	createGoalExtension(mock.pi)

	assert.ok(mock.tools.get_goal)
	assert.ok(mock.tools.update_goal)
	assert.ok(mock.commands.goal)
})

test('createGoalExtension lifecycle: start goal, steering prompt, complete stop', async () => {
	const mock = createMockPi()
	const ext = createGoalExtension(mock.pi)

	const mockCtx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			notify: () => {},
			select: async () => 'Cancel',
			input: async () => '',
			confirm: async () => true
		}
	}

	// 1. User starts goal with /goal
	await mock.commands.goal.handler('Build payment gateway', mockCtx)

	assert.equal(mock.sentMessages.length, 1)
	assert.match(mock.sentMessages[0], /Start working on goal/)
	const currentGoal = ext.getGoal()
	assert.ok(currentGoal)
	assert.equal(currentGoal.objective, 'Build payment gateway')
	assert.equal(currentGoal.status, 'active')

	// 2. before_agent_start generates steering continuation
	const beforeHandlers = mock.listeners.before_agent_start || []
	const startResult = beforeHandlers[0]?.({ prompt: 'Start' }, mockCtx)
	assert.ok(startResult?.message)
	assert.equal(startResult.message.customType, 'goal-steering')
	assert.match(startResult.message.content, /Build payment gateway/)

	// 3. tool_call and update_goal to complete
	const toolCallHandlers = mock.listeners.tool_call || []
	toolCallHandlers[0]?.({ toolName: 'bash', input: { command: 'npm test' } }, mockCtx)

	await mock.tools.update_goal.execute(
		'1',
		{ status: 'complete', reason: 'Payment tests pass.' },
		new AbortController().signal,
		() => {},
		mockCtx as any
	)

	// 4. agent_end
	const agentEndHandlers = mock.listeners.agent_end || []
	agentEndHandlers[0]?.(agentEnd([{ input: 1200, output: 400 }]), mockCtx)

	// 5. agent_settled terminates goal
	const settledHandlers = mock.listeners.agent_settled || []
	await settledHandlers[0]?.({}, mockCtx)

	const finishedGoal = ext.getGoal()
	assert.equal(finishedGoal?.status, 'complete')
	assert.equal(finishedGoal?.lastReason, 'Payment tests pass.')
})

test('sendLoopMessage queues followUp/steer when agent is not idle (reload overlap)', async () => {
	const mock = createMockPi()
	const ext = createGoalExtension(mock.pi)
	const busyCtx = {
		hasUI: true,
		isIdle: () => false,
		ui: {
			setStatus: () => {},
			notify: () => {},
			select: async () => 'Cancel',
			input: async () => '',
			confirm: async () => true
		}
	}

	await mock.commands.goal.handler('Keep shipping', busyCtx)
	assert.equal(mock.sentOptions.at(-1)?.deliverAs, 'followUp')

	const injectCtx = { ...busyCtx }
	await mock.commands.goal.handler('inject mid-stream note', injectCtx)
	assert.equal(mock.sentOptions.at(-1)?.deliverAs, 'steer')
	assert.ok(ext.getGoal())
})

function goalCtx(opts: { idle?: boolean } = {}) {
	const calls = { abort: 0, notices: [] as string[] }
	const ctx = {
		hasUI: true,
		isIdle: () => opts.idle ?? true,
		abort: () => {
			calls.abort++
		},
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus: () => {},
			notify: (m: string) => calls.notices.push(m),
			select: async () => 'Cancel',
			input: async () => '',
			confirm: async () => true
		}
	}
	return { ctx, calls }
}

async function settle(mock: ReturnType<typeof createMockPi>, ctx: unknown, outcome: string) {
	for (const h of mock.listeners.agent_before_settle || []) h({ outcome }, ctx)
	for (const h of mock.listeners.agent_settled || []) await h({}, ctx)
}

test('Esc stops the goal: an aborted run pauses it and sends no continuation', async () => {
	for (const stopReason of ['aborted', 'toolUse'] as const) {
		const mock = createMockPi()
		const ext = createGoalExtension(mock.pi)
		const { ctx } = goalCtx()
		await mock.commands.goal.handler('Refactor billing', ctx)
		const sent = mock.sentMessages.length
		mock.listeners.agent_end?.[0]?.(agentEnd([{ input: 500, output: 100, stopReason }]), ctx)
		await settle(mock, ctx, 'aborted')
		assert.equal(ext.getGoal()?.status, 'paused', stopReason)
		assert.equal(mock.sentMessages.length, sent, `no "Continue" after Esc (${stopReason})`)
	}
})

test('/goal pause and /goal clear abort the run in progress', async () => {
	const mock = createMockPi()
	const ext = createGoalExtension(mock.pi)
	const { ctx, calls } = goalCtx({ idle: false })
	await mock.commands.goal.handler('Refactor billing', ctx)
	await mock.commands.goal.handler('pause', ctx)
	assert.equal(calls.abort, 1)
	const sent = mock.sentMessages.length
	await settle(mock, ctx, 'aborted')
	assert.equal(ext.getGoal()?.status, 'paused')
	assert.equal(mock.sentMessages.length, sent)

	await mock.commands.goal.handler('clear', ctx)
	assert.equal(calls.abort, 2)
	assert.deepEqual(mock.customEntries.at(-1), { type: 'goal-state', data: { cleared: true } })
})

test('tokens come from the replies, and the budget runs one wrap-up turn then stops', async () => {
	const mock = createMockPi()
	const ext = createGoalExtension(mock.pi)
	const { ctx } = goalCtx()
	await mock.commands.goal.handler('Refactor billing', ctx)
	await mock.commands.goal.handler('budget 1000', ctx)
	mock.listeners.before_agent_start?.[0]?.({ prompt: 'x' }, ctx)
	mock.listeners.agent_end?.[0]?.(
		agentEnd([
			{ input: 900, output: 100 },
			{ input: 300, output: 50 }
		]),
		ctx
	)
	assert.equal(ext.getGoal()?.tokensUsed, 1350)
	await settle(mock, ctx, 'completed')
	assert.equal(ext.getGoal()?.status, 'budget_limited')

	const wrap = mock.listeners.before_agent_start?.[0]?.({ prompt: 'x' }, ctx)
	assert.equal(wrap?.message?.customType, 'goal-steering')
	assert.match(wrap?.message?.content ?? '', /budget/i)
	mock.listeners.agent_end?.[0]?.(agentEnd([{ input: 100, output: 20 }]), ctx)
	const sent = mock.sentMessages.length
	await settle(mock, ctx, 'completed')
	assert.equal(ext.getGoal()?.status, 'budget_limited')
	assert.equal(mock.sentMessages.length, sent, 'no turn after the wrap-up')
})

test('restore takes the branch entry, pauses a running goal, and honours clear', () => {
	const goal = { id: 'g', objective: 'o', status: 'active', tokensUsed: 5, turns: 2 }
	const entry = (data: unknown) => ({ type: 'custom', customType: 'goal-state', data }) as never
	assert.equal(restoreGoal([entry(goal)])?.status, 'paused')
	assert.equal(restoreGoal([entry(goal), entry({ cleared: true })]), null)
	assert.equal(restoreGoal([]), null)
})
