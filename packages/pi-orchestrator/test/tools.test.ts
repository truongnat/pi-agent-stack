import assert from 'node:assert/strict'
import test from 'node:test'
import { SubagentManager } from '../src/manager.ts'
import { createOrchestratorTools } from '../src/tools.ts'

test('invoke_subagent tool executes tasks and returns structured markdown artifact', async () => {
	const manager = new SubagentManager({ guard: false })
	const { invokeSubagentTool } = createOrchestratorTools(manager)

	const result = await invokeSubagentTool.execute(
		'1',
		{
			subagents: [{ role: 'researcher', prompt: 'Find auth files' }],
			parallel: true
		},
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)

	const firstText = result.content[0]?.type === 'text' ? result.content[0].text : ''
	assert.match(firstText, /Orchestrator: Dispatched 1 Subagent/)
	assert.match(firstText, /Find auth files/)
})

test('manage_subagents tool handles list, status, kill, and clear actions', async () => {
	const manager = new SubagentManager()
	const { manageSubagentsTool } = createOrchestratorTools(manager)

	// List empty
	const emptyList = await manageSubagentsTool.execute(
		'1',
		{ action: 'list' },
		new AbortController().signal,
		() => {},
		{} as any
	)
	assert.match(
		emptyList.content[0]?.type === 'text' ? emptyList.content[0].text : '',
		/No active or recent subagents/
	)

	// Spawn subagent and list
	const spawned = await manager.spawnSubagent({ role: 'coder', prompt: 'Refactor' }, process.cwd())

	const fullList = await manageSubagentsTool.execute(
		'2',
		{ action: 'list' },
		new AbortController().signal,
		() => {},
		{} as any
	)
	assert.match(
		fullList.content[0]?.type === 'text' ? fullList.content[0].text : '',
		/Managed Subagents/
	)

	// Status
	const statusRes = await manageSubagentsTool.execute(
		'3',
		{ action: 'status', subagent_id: spawned.id },
		new AbortController().signal,
		() => {},
		{} as any
	)
	assert.match(
		statusRes.content[0]?.type === 'text' ? statusRes.content[0].text : '',
		/Subagent Status/
	)

	// Clear
	const clearRes = await manageSubagentsTool.execute(
		'4',
		{ action: 'clear' },
		new AbortController().signal,
		() => {},
		{} as any
	)
	assert.match(
		clearRes.content[0]?.type === 'text' ? clearRes.content[0].text : '',
		/Cleared subagent history/
	)
})

test('send_subagent_message delivers guidance to existing subagent', async () => {
	const manager = new SubagentManager()
	const { sendSubagentMessageTool } = createOrchestratorTools(manager)

	const spawned = await manager.spawnSubagent(
		{ role: 'tester', prompt: 'Run vitest' },
		process.cwd()
	)

	const sendRes = await sendSubagentMessageTool.execute(
		'1',
		{ subagent_id: spawned.id, message: 'Focus on auth.test.ts only' },
		new AbortController().signal,
		() => {},
		{} as any
	)

	assert.match(
		sendRes.content[0]?.type === 'text' ? sendRes.content[0].text : '',
		/Message successfully delivered/
	)
})

test('invoke_subagent tool executes with require_consensus and returns consensus report', async () => {
	const manager = new SubagentManager({ guard: false })
	const { invokeSubagentTool } = createOrchestratorTools(manager)

	const result = await invokeSubagentTool.execute(
		'1',
		{
			subagents: [{ role: 'coder', prompt: 'Implement JWT refresh rotation' }],
			require_consensus: true,
			reviewer_roles: ['reviewer', 'tester']
		},
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)

	const firstText = result.content[0]?.type === 'text' ? result.content[0].text : ''
	assert.match(firstText, /Multi-Agent Consensus Verification Tree/)
	assert.match(firstText, /Multi-Agent Consensus:/)
	assert.match(firstText, /Primary Task/)
})

test('invoke_subagent renderCall and renderResult render clean TUI components with markdown support', async () => {
	const manager = new SubagentManager({ guard: false })
	const { invokeSubagentTool, manageSubagentsTool } = createOrchestratorTools(manager)

	const mockTheme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		underline: (text: string) => text,
		heading: (text: string) => text,
		listBullet: (text: string) => text,
		code: (text: string) => text
	}

	// 1. Call rendering
	const callComp = (invokeSubagentTool as any).renderCall(
		{ subagents: [{ role: 'researcher' }, { role: 'coder' }], parallel: true },
		mockTheme
	)
	assert.ok(callComp)
	assert.match(callComp.text, /DISPATCH 2/)
	assert.match(callComp.text, /RESEARCHER/)

	// 2. Result rendering (collapsed)
	const result = await invokeSubagentTool.execute(
		'1',
		{ subagents: [{ role: 'researcher', prompt: 'Find auth files' }], parallel: true },
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)

	const collapsedComp = (invokeSubagentTool as any).renderResult(
		result,
		{ expanded: false },
		mockTheme
	)
	assert.ok(collapsedComp)
	assert.match(collapsedComp.text, /Subagent DAG/)

	// 3. Result rendering (expanded with Markdown)
	const expandedComp = (invokeSubagentTool as any).renderResult(
		result,
		{ expanded: true },
		mockTheme
	)
	assert.ok(expandedComp)

	// 4. Manage subagents call & result renderers
	const manageCallComp = (manageSubagentsTool as any).renderCall({ action: 'list' }, mockTheme)
	assert.ok(manageCallComp)
	assert.match(manageCallComp.text, /manage_subagents/)
})
