import assert from 'node:assert/strict'
import test from 'node:test'
import { SubagentManager } from '../src/manager.ts'
import { createOrchestratorTools } from '../src/tools.ts'
import { fakeManager } from './fake-runner.ts'

function flattenComponent(c: any): string {
	if (!c) return ''
	const bits: string[] = []
	if (typeof c.text === 'string') bits.push(c.text)
	if (typeof c.render === 'function') {
		try {
			const lines = c.render(100)
			if (Array.isArray(lines)) bits.push(lines.join('\n'))
		} catch {
			// ignore render failures in tests
		}
	}
	if (Array.isArray(c.children)) {
		for (const ch of c.children) bits.push(flattenComponent(ch))
	}
	return bits.join('\n')
}

test('invoke_subagent returns a batch id while workers continue in the background', async () => {
	const manager = fakeManager({ guard: false }).manager
	const { invokeSubagentTool } = createOrchestratorTools(manager)

	const result = await invokeSubagentTool.execute(
		'1',
		{
			subagents: [{ role: 'researcher', prompt: 'Find auth files', scope: ['auth/files'] }],
			parallel: true
		},
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)

	const firstText = result.content[0]?.type === 'text' ? result.content[0].text : ''
	assert.match(firstText, /Started subagent batch/)
	const batchId = (result.details as { batchId: string }).batchId
	assert.equal(typeof batchId, 'string')
	const batch = await manager.waitBatch(batchId)
	assert.equal(batch?.status, 'completed')
	assert.match(batch?.results[0]?.output ?? '', /Completed successfully/)
})

test('invoke_subagent rejects duplicate declared scopes before spawning', async () => {
	const manager = fakeManager({ guard: false }).manager
	const { invokeSubagentTool } = createOrchestratorTools(manager)
	const result = await invokeSubagentTool.execute(
		'1',
		{
			subagents: [
				{ role: 'researcher', prompt: 'Find frontend naming', scope: ['screen:ac12001/naming'] },
				{ role: 'researcher', prompt: 'Find BE naming', scope: ['screen:ac12001/naming'] }
			],
			parallel: true
		},
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)
	assert.equal((result as { isError?: boolean }).isError, true)
	assert.match(
		result.content[0]?.type === 'text' ? result.content[0].text : '',
		/overlapping scope/
	)
	assert.equal(manager.listSubagents().length, 0)
})

test('manage_subagents tool handles list, status, kill, and clear actions', async () => {
	const manager = fakeManager().manager
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

test('send_subagent_message refuses a finished subagent instead of claiming delivery', async () => {
	const manager = fakeManager().manager
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

	assert.match(sendRes.content[0]?.type === 'text' ? sendRes.content[0].text : '', /not delivered/)
	assert.equal((sendRes as { isError?: boolean }).isError, true)
})

test('background batch retains consensus report for later retrieval', async () => {
	const manager = fakeManager({ guard: false }).manager
	const { invokeSubagentTool, manageSubagentsTool } = createOrchestratorTools(manager)

	const result = await invokeSubagentTool.execute(
		'1',
		{
			subagents: [
				{ role: 'coder', prompt: 'Implement JWT refresh rotation', scope: ['auth/refresh'] }
			],
			require_consensus: true,
			reviewer_roles: ['reviewer', 'tester']
		},
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() } as any
	)

	const firstText = result.content[0]?.type === 'text' ? result.content[0].text : ''
	assert.match(firstText, /Started subagent batch/)
	const batchId = (result.details as { batchId: string }).batchId
	await manager.waitBatch(batchId)
	const status = await manageSubagentsTool.execute(
		'2',
		{ action: 'batch_status', batch_id: batchId },
		new AbortController().signal,
		() => {},
		{} as any
	)
	const statusText = status.content[0]?.type === 'text' ? status.content[0].text : ''
	assert.match(statusText, /Multi-Agent Consensus:/)
	assert.match(statusText, /Primary Task|Coder/)
	assert.match(statusText, /Reviewer/)
})

test('invoke_subagent renderCall and renderResult render clean TUI components with markdown support', async () => {
	const manager = fakeManager({ guard: false }).manager
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
		{
			subagents: [{ role: 'researcher', prompt: 'Find auth files', scope: ['auth/files'] }],
			parallel: true
		},
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
	assert.ok(collapsedComp.children && collapsedComp.children.length > 0)

	// 3. Live progress rendering
	const liveProgressResult = {
		content: [{ type: 'text', text: 'Executing...' }],
		details: {
			running: true,
			parallel: true,
			tasks: [
				{
					role: 'researcher',
					name: 'scanner',
					status: 'streaming',
					currentActivity: 'Grep src/auth'
				}
			]
		}
	}
	const liveComp = (invokeSubagentTool as any).renderResult(
		liveProgressResult,
		{ expanded: false },
		mockTheme
	)
	assert.ok(liveComp)
	const liveText = flattenComponent(liveComp)
	assert.match(liveText, /EXECUTING/)
	assert.match(liveText, /Grep src\/auth/)

	// 4. Result rendering (expanded with Markdown)
	const expandedComp = (invokeSubagentTool as any).renderResult(
		{
			content: [{ type: 'text', text: 'ignored' }],
			details: {
				results: [
					{
						name: 'Archimedes',
						role: 'coder',
						status: 'completed',
						durationMs: 12,
						tokensUsed: 8,
						output: '# Report\n\n**FAB07001** → AB07001'
					}
				]
			}
		},
		{ expanded: true },
		mockTheme
	)
	assert.ok(expandedComp)
	const expandedText = flattenComponent(expandedComp)
	assert.match(expandedText, /FAB07001/)
	assert.equal(expandedText.includes('**FAB07001**'), false)
	assert.equal(expandedText.includes('# Report'), false)

	// 5. Manage subagents call & result renderers
	const manageCallComp = (manageSubagentsTool as any).renderCall({ action: 'list' }, mockTheme)
	assert.ok(manageCallComp)
	assert.match(manageCallComp.text, /MANAGE SUBAGENTS/)
})
