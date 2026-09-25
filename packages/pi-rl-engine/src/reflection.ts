import { randomUUID } from 'node:crypto'
import type { LessonEntry } from './lessons.ts'

export interface TrajectoryTurn {
	taskType: string
	prompt: string
	repo: string
	modifiedFiles?: string[]
	errorOutputs?: string[]
	verificationPassed: boolean
	testOutput?: string
	customNote?: string
}

function extractTags(text: string, files: string[] = []): string[] {
	const tags = new Set<string>()

	for (const file of files) {
		const ext = file.split('.').pop()
		if (ext && ext.length <= 5) tags.add(ext.toLowerCase())
		if (file.includes('/')) {
			const parts = file.split('/')
			for (const p of parts) {
				if (p.length >= 3 && !['src', 'test', 'dist', 'lib', 'packages'].includes(p)) {
					tags.add(p.toLowerCase())
				}
			}
		}
	}

	const keywords = [
		'test',
		'build',
		'auth',
		'database',
		'api',
		'git',
		'stream',
		'token',
		'memory',
		'routing',
		'redmine',
		'gdrive',
		'excel',
		'cache',
		'docker',
		'postgres',
		'mysql',
		'redis'
	]

	const lower = text.toLowerCase()
	for (const kw of keywords) {
		if (lower.includes(kw)) tags.add(kw)
	}

	return Array.from(tags).slice(0, 8)
}

export function synthesizeLessonFromTrajectory(turn: TrajectoryTurn): LessonEntry {
	const id = `lsn-${randomUUID().slice(0, 8)}`
	const createdAt = new Date().toISOString()
	const files = turn.modifiedFiles || []

	// Determine concise task summary
	const firstLine = turn.prompt.split('\n')[0].trim()
	const taskSummary = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine

	const symptoms: string[] = []
	if (turn.errorOutputs && turn.errorOutputs.length > 0) {
		for (const err of turn.errorOutputs.slice(0, 3)) {
			const trimmed = err.trim().split('\n')[0]
			if (trimmed) symptoms.push(trimmed.slice(0, 120))
		}
	}

	let successfulStrategy = 'Verified fix passed test and verification checks.'
	let ruleLearned = `Ensure code changes in ${files.map((f) => f.split('/').pop()).join(', ') || 'module'} pass test verifications.`

	if (turn.customNote) {
		successfulStrategy = turn.customNote
		ruleLearned = turn.customNote
	} else if (files.length > 0) {
		successfulStrategy = `Applied modifications to ${files.join(', ')} ensuring clean test execution.`
		ruleLearned = `When working on ${files.map((f) => f.split('/').pop()).join(', ')}, maintain compatibility with test suites.`
	}

	const tags = extractTags(`${turn.prompt} ${ruleLearned} ${successfulStrategy}`, files)

	return {
		id,
		createdAt,
		repo: turn.repo,
		taskType: turn.taskType,
		taskSummary: taskSummary || 'Codebase modification and verification',
		symptoms: symptoms.length > 0 ? symptoms : undefined,
		successfulStrategy,
		ruleLearned,
		tags,
		files,
		confidence: turn.verificationPassed ? 0.9 : 0.6
	}
}
