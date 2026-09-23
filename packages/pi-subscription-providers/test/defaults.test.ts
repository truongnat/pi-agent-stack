import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('Pi default model remains gpt-5.6-luna with high thinking', () => {
	const settings = JSON.parse(
		readFileSync(new URL('../../../config/pi-defaults.json', import.meta.url), 'utf8')
	) as {
		defaultProvider: string
		defaultModel: string
		defaultThinkingLevel: string
	}
	assert.equal(settings.defaultProvider, 'openai-codex')
	assert.equal(settings.defaultModel, 'gpt-5.6-luna')
	assert.equal(settings.defaultThinkingLevel, 'high')
})
