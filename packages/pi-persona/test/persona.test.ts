import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { createPersonaExtension } from '../src/extension.ts'
import { extractPreferencesFromPrompt } from '../src/extractor.ts'
import { PersonaStore } from '../src/store.ts'
import { synthesizePersonaPrompt } from '../src/synthesizer.ts'
import { createPersonaTools } from '../src/tools.ts'

function createTempPaths() {
	const id = Math.random().toString(36).slice(2, 8)
	const storePath = join(tmpdir(), `persona_${id}.json`)
	const markdownPath = join(tmpdir(), `persona_${id}.md`)
	return { storePath, markdownPath }
}

test('PersonaStore initializes with default habits and exports markdown', () => {
	const { storePath, markdownPath } = createTempPaths()
	try {
		const store = new PersonaStore({ storePath, markdownPath })
		const prefs = store.listPreferences()

		assert.ok(prefs.length >= 4)
		assert.ok(existsSync(storePath))
		assert.ok(existsSync(markdownPath))

		const strictTyping = prefs.find((p) => p.key === 'strict_typing_no_any')
		assert.ok(strictTyping)
		assert.equal(strictTyping.category, 'coding')
	} finally {
		if (existsSync(storePath)) rmSync(storePath)
		if (existsSync(markdownPath)) rmSync(markdownPath)
	}
})

test('PersonaStore handles positive reinforcement and negative penalty with Q-updates', () => {
	const { storePath, markdownPath } = createTempPaths()
	try {
		const store = new PersonaStore({ storePath, markdownPath })

		// Reinforce
		const beforeReinforce = store.listPreferences().find((p) => p.key === 'direct_no_fluff')!
		const initialWeight = beforeReinforce.weight
		const initialReinforcements = beforeReinforce.reinforcements
		store.recordPositiveReinforcement('direct_no_fluff')
		const afterReinforce = store.listPreferences().find((p) => p.key === 'direct_no_fluff')!
		const reinforcedWeight = afterReinforce.weight
		assert.ok(reinforcedWeight >= initialWeight)
		assert.equal(afterReinforce.reinforcements, initialReinforcements + 1)

		// Penalize
		store.recordNegativeCorrection('direct_no_fluff', 'Revised rule')
		const afterPenalty = store.listPreferences().find((p) => p.key === 'direct_no_fluff')!
		assert.ok(afterPenalty.weight < reinforcedWeight)
		assert.equal(afterPenalty.rule, 'Revised rule')

	} finally {
		if (existsSync(storePath)) rmSync(storePath)
		if (existsSync(markdownPath)) rmSync(markdownPath)
	}
})

test('extractPreferencesFromPrompt detects user corrections and habits', () => {
	const signals1 = extractPreferencesFromPrompt('nhớ đừng dùng any và viết early return nhé')
	assert.ok(signals1.some((s) => s.key === 'strict_typing_no_any'))
	assert.ok(signals1.some((s) => s.key === 'guard_clauses_early_return'))

	const signals2 = extractPreferencesFromPrompt('trả lời ngắn gọn, bỏ chào hỏi, áp dụng tdd')
	assert.ok(signals2.some((s) => s.key === 'direct_no_fluff'))
	assert.ok(signals2.some((s) => s.key === 'tdd_and_verification'))

	const signals3 = extractPreferencesFromPrompt('hãy xem log trước, bắt exception đừng đoán mò')
	assert.ok(signals3.some((s) => s.key === 'direct_root_cause_triaging'))
})

test('synthesizePersonaPrompt generates targeted steering instructions and prioritizes root cause for bugs', () => {
	const { storePath, markdownPath } = createTempPaths()
	try {
		const store = new PersonaStore({ storePath, markdownPath })
		const prompt = synthesizePersonaPrompt(store, 'implement new auth module')

		assert.ok(prompt)
		assert.ok(prompt.includes('[Developer Persona & Taste Constraints]'))
		assert.ok(prompt.includes('Coding Style:'))
		assert.ok(prompt.includes('Workflow:'))

		// Bug prompt prioritizes root cause triaging
		const bugPrompt = synthesizePersonaPrompt(store, 'fix app crash không load được')
		assert.ok(bugPrompt)
		assert.ok(bugPrompt.includes('direct_root_cause_triaging') || bugPrompt.includes('identify target app/surface first'))
	} finally {
		if (existsSync(storePath)) rmSync(storePath)
		if (existsSync(markdownPath)) rmSync(markdownPath)
	}
})

test('createPersonaTools executes get, update, and feedback tools', async () => {
	const { storePath, markdownPath } = createTempPaths()
	try {
		const store = new PersonaStore({ storePath, markdownPath })
		const { getPersonaTool, updatePersonaTool, feedbackPersonaTool } = createPersonaTools(store)

		// 1. Get persona
		const getRes = await getPersonaTool.execute('1', {}, undefined, () => {}, {} as any)
		assert.match(getRes.content[0]?.text ?? '', /Learned Developer Persona/)

		// 2. Update persona
		const updateRes = await updatePersonaTool.execute(
			'2',
			{
				category: 'coding',
				key: 'use_zod_schema',
				rule: 'Use Zod for all external request payloads.'
			},
			undefined,
			() => {},
			{} as any
		)
		assert.match(updateRes.content[0]?.text ?? '', /use_zod_schema/)

		// 3. Feedback persona
		const feedRes = await feedbackPersonaTool.execute(
			'3',
			{
				key_or_id: 'use_zod_schema',
				signal: 'positive'
			},
			undefined,
			() => {},
			{} as any
		)
		assert.match(feedRes.content[0]?.text ?? '', /Recorded positive feedback/)
	} finally {
		if (existsSync(storePath)) rmSync(storePath)
		if (existsSync(markdownPath)) rmSync(markdownPath)
	}
})

test('createPersonaExtension lifecycle: learns from prompt and injects persona into transient tail message', async () => {
	const registeredTools: any[] = []
	const registeredCommands: Record<string, any> = {}
	const eventHandlers: Record<string, Function[]> = {}

	const mockPi: ExtensionAPI = {
		registerTool: (tool: any) => registeredTools.push(tool),
		registerCommand: (name: string, def: any) => {
			registeredCommands[name] = def
		},
		on: (event: string, handler: Function) => {
			eventHandlers[event] = eventHandlers[event] || []
			eventHandlers[event].push(handler)
		}
	} as unknown as ExtensionAPI

	createPersonaExtension(mockPi)

	assert.equal(registeredTools.length, 3)
	assert.ok(registeredCommands['persona'])

	// Trigger before_agent_start with a correction prompt
	const beforeAgentStartHandler = eventHandlers['before_agent_start']?.[0]
	assert.ok(beforeAgentStartHandler)

	const event = {
		prompt: 'sửa lỗi này đi, lưu ý không dùng any và dùng early return',
		systemPrompt: 'Base instructions.'
	}

	const res = await beforeAgentStartHandler(event, { cwd: process.cwd() })
	// Verify prefix cache preservation: systemPrompt is NOT mutated
	assert.equal(res?.systemPrompt, undefined)
	// Persona steering is passed as a transient message with display: false
	assert.ok(res?.message)
	assert.equal(res.message.customType, 'persona')
	assert.equal(res.message.display, false)
	assert.ok(res.message.content.includes('[Developer Persona & Taste Constraints]'))

	// Global bridge check
	assert.ok((globalThis as any).piAgentStackPersona)
	const globalPrompt = (globalThis as any).piAgentStackPersona.getPersonaPrompt('task')
	assert.ok(globalPrompt)
})
