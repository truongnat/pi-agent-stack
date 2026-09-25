import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LessonStore } from '../src/lessons.ts'
import { synthesizeLessonFromTrajectory } from '../src/reflection.ts'

test('LessonStore saves, retrieves and searches lessons for a repo', () => {
	const tempDir = mkdtempSync(join(tmpdir(), 'pi-lessons-test-'))
	try {
		const store = new LessonStore(tempDir)
		const repo = 'my_test_repo'

		const lesson = synthesizeLessonFromTrajectory({
			taskType: 'fix',
			prompt: 'Fix database query timeout on large user tables',
			repo,
			modifiedFiles: ['src/db/query.ts', 'src/db/pool.ts'],
			verificationPassed: true,
			customNote: 'Add index on user_id and adjust connection pool maxConnections'
		})

		store.saveLesson(lesson)

		const lessons = store.getLessons(repo)
		assert.equal(lessons.length, 1)
		assert.equal(lessons[0].repo, repo)
		assert.match(lessons[0].ruleLearned, /index on user_id/)

		// Search
		const matched = store.findRelevantLessons('database timeout error', repo, 3)
		assert.equal(matched.length, 1)
		assert.equal(matched[0].id, lesson.id)

		// Format for prompt
		const promptBlock = store.formatLessonsForPrompt(matched)
		assert.match(promptBlock, /Relevant Lessons/)
		assert.match(promptBlock, /database query timeout/)
	} finally {
		rmSync(tempDir, { recursive: true, force: true })
	}
})
