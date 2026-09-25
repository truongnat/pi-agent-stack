import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createGoalExtension } from '../src/extension.ts'

function createMockPi() {
	const listeners: Record<string, Function[]> = {}
	const commands: Record<string, any> = {}
	const tools: Record<string, any> = {}
	const customEntries: any[] = []
	const sentMessages: string[] = []

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
		appendEntry(type: string, data: any) {
			customEntries.push({ type, data })
		},
		sendUserMessage(msg: string) {
			sentMessages.push(msg)
		}
	} as unknown as ExtensionAPI

	return { pi, listeners, commands, tools, customEntries, sentMessages }
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
	agentEndHandlers[0]?.({ usage: { input: 1200, output: 400 } }, mockCtx)

	// 5. agent_settled terminates goal
	const settledHandlers = mock.listeners.agent_settled || []
	await settledHandlers[0]?.({}, mockCtx)

	const finishedGoal = ext.getGoal()
	assert.equal(finishedGoal?.status, 'complete')
	assert.equal(finishedGoal?.lastReason, 'Payment tests pass.')
})
