import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { extractPreferencesFromPrompt } from './extractor.ts'
import { PersonaStore } from './store.ts'
import { synthesizePersonaPrompt } from './synthesizer.ts'
import { createPersonaTools } from './tools.ts'
import type { PreferenceCategory } from './types.ts'

export function createPersonaExtension(pi: ExtensionAPI) {
	const store = new PersonaStore()

	// Expose bridge for pi-jev-harness and other extensions
	;(globalThis as any).piAgentStackPersona = {
		getPersonaPrompt: (task: string) => synthesizePersonaPrompt(store, task),
		getPreferences: (category?: PreferenceCategory) => store.listPreferences(category),
		recordFeedback: (key: string, signal: 'positive' | 'negative') =>
			signal === 'positive'
				? store.recordPositiveReinforcement(key)
				: store.recordNegativeCorrection(key)
	}

	// Custom message renderer for persona messages
	if (typeof pi.registerMessageRenderer === 'function') {
		pi.registerMessageRenderer('persona', (message, { expanded, outputPad }, theme) => {
			const raw =
				typeof message.content === 'string'
					? message.content
					: JSON.stringify(message.content)
			const lines = raw
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
			const badge = theme.fg('accent', theme.bold('[ 👤 PERSONA ]'))
			const header = `${badge} ${theme.bold('Developer Persona & Active Habits')}`

			const displayLines = [header]
			if (expanded) {
				displayLines.push(...lines.map((l) => theme.fg('muted', `  ${l}`)))
			} else {
				const preview = lines.slice(0, 3)
				displayLines.push(...preview.map((l) => theme.fg('muted', `  ${l}`)))
				if (lines.length > 3) {
					displayLines.push(
						theme.fg('dim', `  ... and ${lines.length - 3} more habits (expand to view)`)
					)
				}
			}

			const box = new Box(outputPad ?? 1, 0, (t) => theme.bg('customMessageBg', t))
			box.addChild(new Text(displayLines.join('\n'), 0, 0))
			return box
		})
	}

	// 1. Register Tools
	const { getPersonaTool, updatePersonaTool, feedbackPersonaTool } = createPersonaTools(store)
	pi.registerTool(getPersonaTool)
	pi.registerTool(updatePersonaTool)
	pi.registerTool(feedbackPersonaTool)

	// 2. Lifecycle Hooks
	pi.on('session_start', () => {
		store.loadProfile()
	})

	pi.on('before_agent_start', (event, ctx) => {
		if (!store.config.enabled) return undefined

		// Implicit Learning: Extract preference signals from prompt
		const signals = extractPreferencesFromPrompt(event.prompt)
		for (const sig of signals) {
			store.addOrUpdatePreference(sig.category, sig.key, sig.rule, sig.confidence)
		}

		// Synthesize persona guidance as tail message to protect prefix cache
		const personaBlock = synthesizePersonaPrompt(store, event.prompt, store.config.maxInjectedTokens)
		if (!personaBlock) return undefined

		return {
			message: { customType: 'persona', content: personaBlock, display: false }
		}
	})

	// 3. Register Slash Command: /persona
	pi.registerCommand('persona', {
		description: 'Developer Persona & Habit Engine: /persona [list|learn <text>|reset|status]',
		handler: async (args, ctx) => {
			const input = (args ?? '').trim()

			if (input === 'status') {
				const prefs = store.listPreferences()
				const text = [
					'### 👤 Developer Persona Engine Status:',
					`- **Enabled**: \`${store.config.enabled}\``,
					`- **Total Learned Habits**: ${prefs.length}`,
					`- **Store**: \`~/.pi/agent/persona.json\``,
					`- **Profile Markdown**: \`~/.pi/agent/persona.md\``
				].join('\n')
				ctx.ui.notify(text, 'info')
				return
			}

			if (input === 'list') {
				const prefs = store.listPreferences()
				const rows = prefs.map(
					(p) =>
						`• **[${p.category.toUpperCase()}] ${p.key}** (\`${Math.round(p.weight * 100)}%\` confidence, +${p.reinforcements}/-${p.rejections})\n  > ${p.rule}`
				)
				ctx.ui.notify(`### 👤 Active Persona Habits:\n\n${rows.join('\n\n')}`, 'info')
				return
			}

			if (input.startsWith('learn ')) {
				const text = input.replace('learn ', '').trim()
				const signals = extractPreferencesFromPrompt(text)
				if (signals.length > 0) {
					for (const sig of signals) {
						store.addOrUpdatePreference(sig.category, sig.key, sig.rule, sig.confidence)
					}
					ctx.ui.notify(`Learned ${signals.length} habit(s) from input.`, 'info')
				} else {
					// Fallback: generic coding habit
					store.addOrUpdatePreference('coding', `custom_${Date.now().toString(36)}`, text, 0.85)
					ctx.ui.notify(`Added custom habit: "${text}"`, 'info')
				}
				return
			}

			if (input === 'reset') {
				store.resetToDefaults()
				ctx.ui.notify('Reset Persona profile to default developer habits.', 'info')
				return
			}

			// Interactive UI menu
			if (!ctx.hasUI) {
				ctx.ui.notify('Usage: /persona [status|list|learn <text>|reset]', 'info')
				return
			}

			const prefs = store.listPreferences()
			const menuItems = [
				`📋 List Learned Habits (${prefs.length} total)`,
				'🔄 Reset Habits to Defaults',
				'📊 View Persona Status',
				'❌ Close Menu'
			]

			const picked = await ctx.ui.select('👤 Developer Persona & Style Manager', menuItems)
			if (!picked) return

			if (picked.startsWith('📋 List')) {
				const rows = prefs.map(
					(p) =>
						`• **[${p.category.toUpperCase()}] ${p.key}** (\`${Math.round(p.weight * 100)}%\`)\n  > ${p.rule}`
				)
				ctx.ui.notify(`### Persona Habits:\n\n${rows.join('\n\n')}`, 'info')
			} else if (picked.startsWith('🔄 Reset')) {
				store.resetToDefaults()
				ctx.ui.notify('Reset Persona profile to default habits.', 'info')
			} else if (picked.startsWith('📊 View')) {
				ctx.ui.notify(`Persona enabled with ${prefs.length} habits.`, 'info')
			}
		}
	})

	return { store }
}
