import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export interface LessonEntry {
	id: string
	createdAt: string
	repo: string
	taskType: string
	taskSummary: string
	symptoms?: string[]
	failedAttempts?: string[]
	rootCause?: string
	successfulStrategy: string
	ruleLearned: string
	tags: string[]
	files?: string[]
	confidence?: number
}

const LESSONS_DIR = join(homedir(), '.pi', 'agent', 'lessons')

// A name with a source extension is a tool, not a model: llama.cpp, whisper.cpp-style ports.
const MODEL_ID = String.raw`(?:gpt-?\d|o\d\b|claude|sonnet|opus|haiku|gemini|grok|deepseek|llama|qwen|mistral|kimi|glm)(?![\w-]*\.(?:cpp|c|js|ts|py|rs|go)\b)[\w.-]*`

/** A model id ends the clause: "use gpt-5." pins a model, "use gpt-4 tokenizer" does not. */
const CLAUSE_END = String.raw`(?=\s*(?:$|[,;:!?)\n]|\.(?:\s|$)|(?:for|when|if|instead|rather|and|or|because|unless|on|in)\b))`

/** Runtime facts ("current model is X") and model pins ("always use X") go stale on the next
 * model change; routing is JEV's job, not a lesson's. Pattern from KiroCrew lesson_validation. */
const VOLATILE = [
	/\b(?:current|active|selected|session)\s+model(?:\s+identity)?\s*(?:is\b|was\b|[:=])/i,
	new RegExp(String.raw`\brunning\s+as\s+(?:the\s+)?(?:model\b|${MODEL_ID})`, 'i'),
	new RegExp(
		String.raw`\b(?:use|choose|select|prefer|switch\s+to|stick\s+with)\s+(?:the\s+)?(?:model\s+)?${MODEL_ID}(?:\s+model)?${CLAUSE_END}`,
		'i'
	)
]

/** Whether a lesson records a runtime model fact or a model pin instead of durable know-how. */
export function volatileLesson(
	lesson: Pick<LessonEntry, 'ruleLearned' | 'successfulStrategy'>
): boolean {
	return [lesson.ruleLearned, lesson.successfulStrategy].some(
		(text) => text && VOLATILE.some((re) => re.test(text))
	)
}

export class LessonStore {
	private baseDir: string

	constructor(baseDir = LESSONS_DIR) {
		this.baseDir = baseDir
		try {
			mkdirSync(this.baseDir, { recursive: true })
		} catch {
			// ignore
		}
	}

	public sanitizeRepoName(repoPath: string): string {
		const name = basename(repoPath).replace(/[^a-zA-Z0-9._-]/g, '_')
		return name || 'global'
	}

	public getRepoFilePath(repo: string): string {
		return join(this.baseDir, `${repo}.jsonl`)
	}

	public getRepoSummaryPath(repo: string): string {
		return join(this.baseDir, `${repo}-summary.md`)
	}

	/** Returns false when the lesson is refused as volatile or cannot be written. */
	public saveLesson(lesson: LessonEntry): boolean {
		if (volatileLesson(lesson)) return false
		try {
			mkdirSync(this.baseDir, { recursive: true })
			const file = this.getRepoFilePath(lesson.repo)
			appendFileSync(file, `${JSON.stringify(lesson)}\n`, 'utf8')
			this.updateSummaryMarkdown(lesson.repo)
			return true
		} catch (err) {
			console.error('Failed to save lesson:', err)
			return false
		}
	}

	public getLessons(repo: string): LessonEntry[] {
		const file = this.getRepoFilePath(repo)
		if (!existsSync(file)) return []
		try {
			const lines = readFileSync(file, 'utf8')
				.split('\n')
				.filter((l) => l.trim().length > 0)
			return lines.map((l) => JSON.parse(l) as LessonEntry)
		} catch {
			return []
		}
	}

	public deleteLesson(repo: string, lessonId: string): boolean {
		const file = this.getRepoFilePath(repo)
		if (!existsSync(file)) return false
		try {
			const existing = this.getLessons(repo)
			const filtered = existing.filter((l) => l.id !== lessonId)
			if (filtered.length === existing.length) return false

			const content =
				filtered.map((l) => JSON.stringify(l)).join('\n') + (filtered.length > 0 ? '\n' : '')
			writeFileSync(file, content, 'utf8')
			this.updateSummaryMarkdown(repo)
			return true
		} catch {
			return false
		}
	}

	public clearLessons(repo: string): boolean {
		const file = this.getRepoFilePath(repo)
		const summaryFile = this.getRepoSummaryPath(repo)
		try {
			if (existsSync(file)) writeFileSync(file, '', 'utf8')
			if (existsSync(summaryFile)) writeFileSync(summaryFile, '', 'utf8')
			return true
		} catch {
			return false
		}
	}

	public getAllLessons(): LessonEntry[] {
		if (!existsSync(this.baseDir)) return []
		const files = readdirSync(this.baseDir).filter((f: string) => f.endsWith('.jsonl'))
		const all: LessonEntry[] = []
		for (const f of files) {
			try {
				const lines = readFileSync(join(this.baseDir, f), 'utf8')
					.split('\n')
					.filter((l) => l.trim().length > 0)
				for (const line of lines) {
					all.push(JSON.parse(line) as LessonEntry)
				}
			} catch {
				// ignore
			}
		}
		return all
	}

	/**
	 * Enhanced Semantic Ranking:
	 * 1. Multi-token & exact substring matching
	 * 2. Tag & Path overlap boosting
	 * 3. Task type congruence boost
	 * 4. Confidence & recency weighting
	 */
	public findRelevantLessons(prompt: string, repo: string, limit = 3): LessonEntry[] {
		const lessons = this.getLessons(repo).filter((lesson) => !volatileLesson(lesson))
		if (lessons.length === 0) return []

		const promptLower = prompt.toLowerCase()
		const tokens = promptLower
			.split(/[^a-zA-Z0-9_\u00C0-\u1EF9\u3040-\u30FF\u4E00-\u9FAF]+/)
			.filter(
				(t) =>
					t.length >= 2 &&
					!['in', 'on', 'at', 'to', 'for', 'of', 'and', 'the', 'a', 'an', 'is'].includes(t)
			)

		if (tokens.length === 0) return lessons.slice(-limit)

		const now = Date.now()

		const scored = lessons.map((lesson) => {
			let score = 0
			const haystackText = [
				lesson.taskSummary,
				lesson.ruleLearned,
				lesson.successfulStrategy,
				lesson.rootCause ?? '',
				...(lesson.tags || []),
				...(lesson.files || [])
			]
				.join(' ')
				.toLowerCase()

			const haystackTokens = new Set(
				haystackText
					.split(/[^a-zA-Z0-9_\u00C0-\u1EF9\u3040-\u30FF\u4E00-\u9FAF]+/)
					.filter((t) => t.length >= 2)
			)

			// 1. Token presence score (exact token or prefix match)
			for (const tok of tokens) {
				if (haystackTokens.has(tok)) {
					score += tok.length >= 5 ? 4 : tok.length >= 3 ? 3 : 2
				} else {
					// Check if any haystack token starts with this token (for stemming, e.g. "pool" in "pools")
					for (const hTok of haystackTokens) {
						if (hTok.startsWith(tok) || (tok.length >= 4 && tok.startsWith(hTok))) {
							score += 2
							break
						}
					}
				}
			}

			// 2. Exact phrase bonus (bigrams/trigrams)
			if (
				lesson.taskSummary &&
				promptLower.includes(lesson.taskSummary.toLowerCase().slice(0, 30))
			) {
				score += 6
			}
			if (
				lesson.ruleLearned &&
				promptLower.includes(lesson.ruleLearned.toLowerCase().slice(0, 30))
			) {
				score += 6
			}

			// 3. Tag exact match bonus
			for (const tag of lesson.tags || []) {
				const tagLower = tag.toLowerCase()
				if (promptLower.includes(tagLower)) {
					score += 4
				}
			}

			// 4. File name / path match bonus
			for (const file of lesson.files || []) {
				const base = basename(file).toLowerCase()
				if (promptLower.includes(base) || promptLower.includes(file.toLowerCase())) {
					score += 5
				}
			}

			// 5. Task-type congruence
			if (
				(promptLower.includes('fix') ||
					promptLower.includes('bug') ||
					promptLower.includes('error')) &&
				lesson.taskType === 'fix'
			) {
				score += 2
			} else if (
				(promptLower.includes('refactor') || promptLower.includes('clean')) &&
				lesson.taskType === 'refactor'
			) {
				score += 2
			} else if (
				(promptLower.includes('test') || promptLower.includes('spec')) &&
				lesson.taskType === 'test'
			) {
				score += 2
			}

			// 6. Confidence multiplier & recency boost only if there's a match
			if (score > 0) {
				const conf = lesson.confidence ?? 0.8
				score *= conf

				// Slight recency boost (within 7 days)
				try {
					const createdMs = new Date(lesson.createdAt).getTime()
					const daysOld = (now - createdMs) / (1000 * 60 * 60 * 24)
					if (daysOld <= 7) score += 1.5
					else if (daysOld <= 30) score += 0.5
				} catch {
					// ignore date parsing error
				}
			}

			return { lesson, score }
		})

		return scored
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((s) => s.lesson)
	}

	public formatLessonsForPrompt(lessons: LessonEntry[]): string {
		if (lessons.length === 0) return ''
		const lines: string[] = ['### 💡 Relevant Lessons & Rules from Past Work in this Codebase:']
		for (const [idx, item] of lessons.entries()) {
			const tagsStr = item.tags && item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : ''
			lines.push(`${idx + 1}. **[${item.taskType.toUpperCase()}] ${item.taskSummary}**${tagsStr}`)
			if (item.ruleLearned) {
				lines.push(`   - **Rule/Lesson**: ${item.ruleLearned}`)
			}
			if (item.successfulStrategy) {
				lines.push(`   - **Strategy**: ${item.successfulStrategy}`)
			}
			if (item.rootCause) {
				lines.push(`   - **Root Cause to Avoid**: ${item.rootCause}`)
			}
		}
		return lines.join('\n')
	}

	private updateSummaryMarkdown(repo: string): void {
		const lessons = this.getLessons(repo)
		if (lessons.length === 0) {
			try {
				writeFileSync(
					this.getRepoSummaryPath(repo),
					`# Learned Lessons & Memory for Repository: \`${repo}\`\n\n*(No lessons recorded)*\n`,
					'utf8'
				)
			} catch {
				// ignore
			}
			return
		}
		const mdLines: string[] = [
			`# Learned Lessons & Memory for Repository: \`${repo}\``,
			'',
			`*Total Lessons Recorded*: ${lessons.length}`,
			'',
			'| ID | Task | Rule / Lesson Learned | Strategy | Tags | Date |',
			'| --- | --- | --- | --- | --- | --- |'
		]

		for (const l of lessons.slice(-30).reverse()) {
			const dateStr = l.createdAt.slice(0, 10)
			const rule = (l.ruleLearned || '-').replace(/\|/g, '\\|')
			const strat = (l.successfulStrategy || '-').replace(/\|/g, '\\|')
			const summary = (l.taskSummary || '-').replace(/\|/g, '\\|')
			const tags = (l.tags || []).join(', ')
			mdLines.push(
				`| \`${l.id}\` | ${summary} | **${rule}** | ${strat} | \`${tags}\` | ${dateStr} |`
			)
		}

		mdLines.push('')
		try {
			writeFileSync(this.getRepoSummaryPath(repo), mdLines.join('\n'), 'utf8')
		} catch {
			// ignore
		}
	}
}
