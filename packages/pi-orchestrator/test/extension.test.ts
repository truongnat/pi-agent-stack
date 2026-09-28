import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createOrchestratorExtension } from '../src/extension.ts'

function createMockPi() {
	const listeners: Record<string, Function[]> = {}
	const commands: Record<string, any> = {}
	const tools: Record<string, any> = {}

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
		}
	} as unknown as ExtensionAPI

	return { pi, listeners, commands, tools }
}

test('createOrchestratorExtension registers tools and /agents command', async () => {
	const mock = createMockPi()
	const { manager: _manager } = createOrchestratorExtension(mock.pi)

	assert.ok(mock.tools.invoke_subagent)
	assert.ok(mock.tools.manage_subagents)
	assert.ok(mock.tools.send_subagent_message)
	assert.ok(mock.commands.agents)

	const mockCtx: any = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			notify: (_text: string) => {},
			select: async () => 'Cancel',
			input: async () => '',
			confirm: async () => true
		}
	}

	// Test /agents roster command
	let notifiedText = ''
	mockCtx.ui.notify = (text: string) => {
		notifiedText = text
	}

	await mock.commands.agents.handler('roster', mockCtx)
	assert.match(notifiedText, /Available Subagent Roster/)
})

test('session_shutdown kills running workers', async () => {
	const mock = createMockPi()
	const { manager } = createOrchestratorExtension(mock.pi)
	let killed = 0
	if (manager) manager.killAll = () => ++killed
	for (const h of mock.listeners.session_shutdown ?? []) await h({ type: 'session_shutdown' }, {})
	assert.equal(killed, 1)
})
