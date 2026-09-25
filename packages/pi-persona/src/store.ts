import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PersonaConfig, PersonaProfile, PreferenceCategory, UserPreference } from './types.ts'

export const STORE_PATH = join(homedir(), '.pi', 'agent', 'persona.json')
export const MARKDOWN_PATH = join(homedir(), '.pi', 'agent', 'persona.md')
export const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'persona-config.json')

export const DEFAULT_CONFIG: PersonaConfig = {
	enabled: true,
	maxInjectedTokens: 100,
	minConfidenceThreshold: 0.5,
	defaults: [
		{
			id: 'habit_concise_comm',
			category: 'communication',
			key: 'direct_no_fluff',
			rule: 'Provide concise, direct answers with clear bullet points and actionable code diffs without conversational fluff.',
			weight: 0.9,
			reinforcements: 5,
			rejections: 0,
			createdAt: Date.now(),
			lastAppliedAt: Date.now()
		},
		{
			id: 'habit_strict_typing',
			category: 'coding',
			key: 'strict_typing_no_any',
			rule: 'Ensure strict type safety in TypeScript: use explicit interfaces/types, TypeBox schemas, and never use any.',
			weight: 0.9,
			reinforcements: 5,
			rejections: 0,
			createdAt: Date.now(),
			lastAppliedAt: Date.now()
		},
		{
			id: 'habit_minimal_diff',
			category: 'coding',
			key: 'minimal_diff_preservation',
			rule: 'Preserve existing style, indentation, docstrings, and unrelated code; make minimal focused edits.',
			weight: 0.85,
			reinforcements: 4,
			rejections: 0,
			createdAt: Date.now(),
			lastAppliedAt: Date.now()
		},
		{
			id: 'habit_direct_root_cause',
			category: 'workflow',
			key: 'direct_root_cause_triaging',
			rule: 'When diagnosing bugs or UI/app loading issues in monorepos: identify target app/surface first, then extract unhandled exception or network logs before modifying code/DB.',
			weight: 0.95,
			reinforcements: 5,
			rejections: 0,
			createdAt: Date.now(),
			lastAppliedAt: Date.now()
		},
		{
			id: 'habit_tdd_verification',
			category: 'workflow',
			key: 'tdd_and_verification',
			rule: 'Verify changes by running the automated test suite (e.g. npm test) before finishing.',
			weight: 0.85,
			reinforcements: 4,
			rejections: 0,
			createdAt: Date.now(),
			lastAppliedAt: Date.now()
		}
	]
}

export class PersonaStore {
	public config: PersonaConfig
	private profile: PersonaProfile
	private storePath: string
	private markdownPath: string

	constructor(options: { storePath?: string; markdownPath?: string; config?: Partial<PersonaConfig> } = {}) {
		this.storePath = options.storePath ?? STORE_PATH
		this.markdownPath = options.markdownPath ?? MARKDOWN_PATH
		this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) }
		this.profile = this.loadProfile()
	}

	public loadProfile(): PersonaProfile {
		try {
			if (existsSync(this.storePath)) {
				const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as PersonaProfile
				if (Array.isArray(raw.preferences)) {
					// Auto-merge any new default habits if not present
					let modified = false
					for (const def of this.config.defaults ?? DEFAULT_CONFIG.defaults ?? []) {
						if (!raw.preferences.some((p) => p.id === def.id || p.key === def.key)) {
							raw.preferences.push({ ...def })
							modified = true
						}
					}
					if (modified) {
						this.saveProfile(raw)
					}
					return raw
				}
			}
		} catch {
			// Fallback to defaults on corrupt/missing file
		}

		const initialProfile: PersonaProfile = {
			version: '1.0.0',
			updatedAt: Date.now(),
			preferences: [...(this.config.defaults ?? DEFAULT_CONFIG.defaults ?? [])]
		}
		this.saveProfile(initialProfile)
		return initialProfile
	}

	public saveProfile(profile: PersonaProfile = this.profile): void {
		try {
			mkdirSync(dirname(this.storePath), { recursive: true })
			profile.updatedAt = Date.now()
			writeFileSync(this.storePath, JSON.stringify(profile, null, 2), 'utf8')

			// Render human-readable persona.md
			this.exportMarkdown(profile)
		} catch {
			// Ignore filesystem write errors
		}
	}

	private exportMarkdown(profile: PersonaProfile): void {
		try {
			mkdirSync(dirname(this.markdownPath), { recursive: true })
			const lines = [
				'# 👤 Developer Persona Profile (Learned Habits)',
				'',
				`*Last Updated: ${new Date(profile.updatedAt).toISOString()}*`,
				'',
				'## 💻 Coding Habits',
				...this.renderCategoryMarkdown(profile.preferences, 'coding'),
				'',
				'## ⚙️ Workflow Habits',
				...this.renderCategoryMarkdown(profile.preferences, 'workflow'),
				'',
				'## 💬 Communication Habits',
				...this.renderCategoryMarkdown(profile.preferences, 'communication'),
				''
			]
			writeFileSync(this.markdownPath, lines.join('\n'), 'utf8')
		} catch {
			// Ignore markdown write error
		}
	}

	private renderCategoryMarkdown(prefs: UserPreference[], category: PreferenceCategory): string[] {
		const filtered = prefs
			.filter((p) => p.category === category)
			.sort((a, b) => b.weight - a.weight)

		if (filtered.length === 0) return ['*(No learned habits yet)*']

		return filtered.map(
			(p) =>
				`- **${p.key}** (Confidence: \`${Math.round(p.weight * 100)}%\`, +${p.reinforcements}/-${p.rejections})\n  > ${p.rule}`
		)
	}

	public listPreferences(category?: PreferenceCategory): UserPreference[] {
		const list = category
			? this.profile.preferences.filter((p) => p.category === category)
			: this.profile.preferences
		return [...list].sort((a, b) => b.weight - a.weight)
	}

	public addOrUpdatePreference(
		category: PreferenceCategory,
		key: string,
		rule: string,
		initialWeight = 0.8
	): UserPreference {
		const existingIndex = this.profile.preferences.findIndex((p) => p.key === key)
		const now = Date.now()

		if (existingIndex >= 0) {
			const existing = this.profile.preferences[existingIndex]!
			existing.rule = rule
			existing.category = category
			existing.weight = Math.min(1.0, Math.max(0.1, (existing.weight + initialWeight) / 2))
			existing.reinforcements++
			existing.lastAppliedAt = now
			this.saveProfile()
			return existing
		}

		const newPref: UserPreference = {
			id: `pref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			category,
			key,
			rule,
			weight: initialWeight,
			reinforcements: 1,
			rejections: 0,
			createdAt: now,
			lastAppliedAt: now
		}

		this.profile.preferences.push(newPref)
		this.saveProfile()
		return newPref
	}

	public recordPositiveReinforcement(keyOrId: string): boolean {
		const pref = this.profile.preferences.find((p) => p.key === keyOrId || p.id === keyOrId)
		if (!pref) return false
		pref.weight = Math.min(1.0, pref.weight + 0.05)
		pref.reinforcements++
		pref.lastAppliedAt = Date.now()
		this.saveProfile()
		return true
	}

	public recordNegativeCorrection(keyOrId: string, updatedRule?: string): boolean {
		const pref = this.profile.preferences.find((p) => p.key === keyOrId || p.id === keyOrId)
		if (!pref) return false
		pref.weight = Math.max(0.1, pref.weight - 0.15)
		pref.rejections++
		if (updatedRule) pref.rule = updatedRule
		pref.lastAppliedAt = Date.now()
		this.saveProfile()
		return true
	}

	public resetToDefaults(): void {
		this.profile = {
			version: '1.0.0',
			updatedAt: Date.now(),
			preferences: [...(this.config.defaults ?? DEFAULT_CONFIG.defaults ?? [])]
		}
		this.saveProfile()
	}
}
