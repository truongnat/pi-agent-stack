import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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

test('volatile lessons (current model facts, model pins) are refused; tooling mentions are kept', () => {
	const tempDir = mkdtempSync(join(tmpdir(), 'pi-lessons-test-'))
	try {
		const store = new LessonStore(tempDir)
		const lesson = (ruleLearned: string) => ({
			id: ruleLearned,
			createdAt: '2026-09-25T00:00:00Z',
			repo: 'r',
			taskType: 'fix',
			taskSummary: 's',
			successfulStrategy: '-',
			ruleLearned,
			tags: []
		})
		for (const rule of [
			'The current model is gpt-6-luna.',
			'Always use claude-sonnet-5 for refactors',
			'Switch to grok-4.6.',
			'When tests are slow, prefer deepseek',
			'Running as opus here'
		]) {
			assert.equal(store.saveLesson(lesson(rule)), false, rule)
		}
		for (const rule of [
			'Use the gpt-4 tokenizer to count tokens before trimming',
			'Pin the claude-code CLI version in CI',
			'Use llama.cpp for local inference in the offline tests',
			'Add an index on user_id before paging large tables'
		]) {
			assert.equal(store.saveLesson(lesson(rule)), true, rule)
		}
		assert.equal(store.getLessons('r').length, 4)
	} finally {
		rmSync(tempDir, { recursive: true, force: true })
	}
})
