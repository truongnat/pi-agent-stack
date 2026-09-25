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

	public findRelevantLessons(prompt: string, repo: string, limit = 3): LessonEntry[] {
		// Rows saved before validation existed are filtered on the way out.
		const lessons = this.getLessons(repo).filter((lesson) => !volatileLesson(lesson))
		if (lessons.length === 0) return []

		const tokens = prompt
			.toLowerCase()
			.split(/[^a-zA-Z0-9_\u00C0-\u1EF9\u3040-\u30FF\u4E00-\u9FAF]+/)
			.filter((t) => t.length >= 2)

		if (tokens.length === 0) return lessons.slice(-limit)

		const scored = lessons.map((lesson) => {
			let score = 0
			const haystack = [
				lesson.taskSummary,
				lesson.ruleLearned,
				lesson.successfulStrategy,
				lesson.rootCause ?? '',
				...(lesson.tags || []),
				...(lesson.files || [])
			]
				.join(' ')
				.toLowerCase()

			for (const tok of tokens) {
				if (haystack.includes(tok)) {
					score += tok.length >= 4 ? 2 : 1
				}
			}

			// Boost if specific tags match
			for (const tag of lesson.tags || []) {
				if (prompt.toLowerCase().includes(tag.toLowerCase())) {
					score += 3
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
			lines.push(`${idx + 1}. **[${item.taskType.toUpperCase()}] ${item.taskSummary}**`)
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
		if (lessons.length === 0) return
		const mdLines: string[] = [
			`# Learned Lessons & Memory for Repository: \`${repo}\``,
			'',
			`*Total Lessons Recorded*: ${lessons.length}`,
			'',
			'| ID | Task | Rule / Lesson Learned | Strategy | Date |',
			'| --- | --- | --- | --- | --- |'
		]

		for (const l of lessons.slice(-30).reverse()) {
			const dateStr = l.createdAt.slice(0, 10)
			const rule = (l.ruleLearned || '-').replace(/\|/g, '\\|')
			const strat = (l.successfulStrategy || '-').replace(/\|/g, '\\|')
			const summary = (l.taskSummary || '-').replace(/\|/g, '\\|')
			mdLines.push(`| \`${l.id}\` | ${summary} | **${rule}** | ${strat} | ${dateStr} |`)
		}

		mdLines.push('')
		try {
			writeFileSync(this.getRepoSummaryPath(repo), mdLines.join('\n'), 'utf8')
		} catch {
			// ignore
		}
	}
}
