import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createOrchestratorMcpServer } from '../src/mcp-server.ts'
import { fakeManager } from './fake-runner.ts'

test('MCP bridge exposes only orchestrator tools and handles a management call', async () => {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'test-root', version: '1.0.0' })
	const server = createOrchestratorMcpServer(fakeManager({ guard: false }).manager, process.cwd())
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
	try {
		const { tools } = await client.listTools()
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [
			'invoke_subagent',
			'manage_subagents',
			'send_subagent_message'
		])
		const result = await client.callTool({
			name: 'manage_subagents',
			arguments: { action: 'list' }
		})
		assert.match(JSON.stringify(result), /No active or recent subagents/)
	} finally {
		await client.close()
		await server.close()
	}
})
