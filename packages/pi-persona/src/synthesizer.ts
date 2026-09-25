import type { PersonaStore } from './store.ts'
import type { PreferenceCategory, UserPreference } from './types.ts'

/**
 * Synthesize a compact, targeted Persona steering prompt tailored to the active task.
 */
export function synthesizePersonaPrompt(
	store: PersonaStore,
	task: string,
	maxTokens = 80
): string | null {
	if (!store.config.enabled) return null

	const minThreshold = store.config.minConfidenceThreshold ?? 0.5
	const allPrefs = store.listPreferences().filter((p) => p.weight >= minThreshold)

	if (allPrefs.length === 0) return null

	// Pick top preferences per category
	const coding = allPrefs.filter((p) => p.category === 'coding').slice(0, 2)
	
	const isBugOrIssue = /\b(bug|fix|error|fail|broken|crash|load|issue|lỗi|không)\b/i.test(task)
	const workflowSorted = [...allPrefs.filter((p) => p.category === 'workflow')].sort((a, b) => {
		if (isBugOrIssue) {
			if (a.key.includes('root_cause')) return -1
			if (b.key.includes('root_cause')) return 1
		}
		return b.weight - a.weight
	})
	const workflow = workflowSorted.slice(0, 2)
	const comm = allPrefs.filter((p) => p.category === 'communication').slice(0, 1)

	const selected = [...coding, ...workflow, ...comm]
	if (selected.length === 0) return null

	const lines = ['[Developer Persona & Taste Constraints]']

	if (coding.length > 0) {
		lines.push(`• Coding Style: ${coding.map((p) => p.rule).join(' ')}`)
	}
	if (workflow.length > 0) {
		lines.push(`• Workflow: ${workflow.map((p) => p.rule).join(' ')}`)
	}
	if (comm.length > 0) {
		lines.push(`• Communication: ${comm.map((p) => p.rule).join(' ')}`)
	}

	return lines.join('\n')
}
