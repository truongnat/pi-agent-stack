import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerRLExtension } from '../src/extension.ts'

test('RL Extension E2E: Full lifecycle execution test (Lesson capture, Reflection, Command, Injection)', async () => {
	const tempDir = mkdtempSync(join(tmpdir(), 'pi-rl-extension-e2e-'))

	try {
		// Mock package.json in temp workspace so test detection works
		writeFileSync(
			join(tempDir, 'package.json'),
			JSON.stringify({ name: 'test-app', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)
		)

		// Create mock ExtensionAPI
		const registeredEvents: Record<string, Function> = {}
		const registeredCommands: Record<string, { description: string; handler: Function }> = {}
		const notifications: string[] = []

		// Only the three methods the extension calls at registration; the overloads don't matter here.
		const mockPi = {
			on: (event: string, handler: Function) => {
				registeredEvents[event] = handler
			},
			registerCommand: (name: string, def: { description: string; handler: Function }) => {
				registeredCommands[name] = def
			},
			getThinkingLevel: () => 'high'
		}

		registerRLExtension(mockPi as unknown as ExtensionAPI)

		// 1. Verify extension registered expected hooks and slash commands
		assert.ok(registeredEvents['session_start'])
		assert.ok(registeredEvents['before_agent_start'])
		assert.ok(registeredEvents['agent_end'])
		assert.ok(registeredCommands['rl'])
		assert.ok(registeredCommands['lessons'])
		assert.ok(registeredCommands['reflect'])
		assert.ok(registeredCommands['rl-verify'])

		const mockCtx = {
			cwd: tempDir,
			hasUI: true,
			model: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
			ui: {
				setStatus: () => {},
				notify: (msg: string) => {
					notifications.push(msg)
				}
			}
		}

		// 2. Session start
		registeredEvents['session_start']({}, mockCtx)

		// 3. First turn: user asks to fix an issue
		const beforeResult1 = registeredEvents['before_agent_start'](
			{
				prompt: 'Fix Redis cache connection pool leak during high concurrency',
				systemPrompt: 'Base system prompt'
			},
			mockCtx
		)
		// Initially no lessons exist for this new temp repo
		assert.equal(beforeResult1, undefined)

		// 4. Test manual /reflect command
		await registeredCommands['reflect'].handler(
			'Always release redis clients in a finally block',
			mockCtx
		)
		assert.ok(
			notifications.some(
				(n) => n.includes('Saved lesson') && n.includes('Always release redis clients')
			)
		)

		// 5. Test /lessons slash commands
		await registeredCommands['lessons'].handler('', mockCtx)
		assert.ok(notifications.some((n) => n.includes('Learned Lessons')))

		await registeredCommands['lessons'].handler('search redis', mockCtx)
		assert.ok(notifications.some((n) => n.includes('Matched Lessons for "redis"')))

		// 6. Next turn: User asks about Redis again -> Should inject the learned lesson!
		const beforeResult2 = registeredEvents['before_agent_start'](
			{
				prompt: 'We are seeing redis connection timeout errors again',
				systemPrompt: 'Base prompt'
			},
			mockCtx
		)
		assert.ok(beforeResult2 && beforeResult2.systemPrompt)
		assert.match(beforeResult2.systemPrompt, /Relevant Lessons & Rules/)
		assert.match(beforeResult2.systemPrompt, /Always release redis clients/)

		// 7. Verify /rl stats
		await registeredCommands['rl'].handler('', mockCtx)
		assert.ok(notifications.some((n) => n.includes('Pi RL Engine')))

		// 8. Test /lessons clear
		await registeredCommands['lessons'].handler('clear', mockCtx)
		assert.ok(notifications.some((n) => n.includes('Cleared all learned lessons')))
	} finally {
		rmSync(tempDir, { recursive: true, force: true })
	}
})
