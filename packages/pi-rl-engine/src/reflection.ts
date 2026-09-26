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
				if (
					p.length >= 3 &&
					!['src', 'test', 'dist', 'lib', 'packages', 'node_modules'].includes(p)
				) {
					tags.add(p.toLowerCase())
				}
			}
		}
	}

	const domainKeywords = [
		'test',
		'spec',
		'unit',
		'e2e',
		'build',
		'compile',
		'bundle',
		'auth',
		'jwt',
		'oauth',
		'session',
		'database',
		'db',
		'sql',
		'postgres',
		'mysql',
		'sqlite',
		'prisma',
		'drizzle',
		'typeorm',
		'api',
		'rest',
		'graphql',
		'grpc',
		'websocket',
		'http',
		'git',
		'branch',
		'merge',
		'diff',
		'stream',
		'buffer',
		'sse',
		'token',
		'quota',
		'rate-limit',
		'memory',
		'leak',
		'gc',
		'cache',
		'redis',
		'memcached',
		'routing',
		'router',
		'gateway',
		'proxy',
		'redmine',
		'gdrive',
		'excel',
		'csv',
		'json',
		'docker',
		'k8s',
		'container',
		'ci',
		'react',
		'nextjs',
		'vue',
		'svelte',
		'hono',
		'express',
		'fastify',
		'nest',
		'bun',
		'node',
		'deno',
		'vite',
		'webpack',
		'tui',
		'cli',
		'ink',
		'blessed',
		'term'
	]

	const lower = text.toLowerCase()
	for (const kw of domainKeywords) {
		if (lower.includes(kw)) tags.add(kw)
	}

	return Array.from(tags).slice(0, 10)
}

function extractRootCause(errors: string[] = []): string | undefined {
	if (!errors || errors.length === 0) return undefined
	for (const err of errors) {
		const lines = err
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
		for (const line of lines) {
			if (
				line.includes('Error:') ||
				line.includes('TypeError:') ||
				line.includes('SyntaxError:') ||
				line.includes('ReferenceError:') ||
				line.includes('UnhandledPromiseRejection') ||
				line.includes('FAIL') ||
				line.includes('failed')
			) {
				return line.slice(0, 150)
			}
		}
	}
	return errors[0]?.slice(0, 150)
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

	const rootCause = extractRootCause(turn.errorOutputs)

	let successfulStrategy = 'Verified fix passed test and verification checks.'
	let ruleLearned = `Ensure code changes in ${files.map((f) => f.split('/').pop()).join(', ') || 'module'} pass test verifications.`

	if (turn.customNote) {
		successfulStrategy = turn.customNote
		ruleLearned = turn.customNote
	} else if (files.length > 0) {
		const baseNames = files.map((f) => f.split('/').pop()).join(', ')
		successfulStrategy = `Modified ${baseNames} to resolve issues and satisfy test verification.`
		ruleLearned = `When modifying ${baseNames}, preserve API contract and verify with targeted unit tests.`
	}

	const tags = extractTags(
		`${turn.prompt} ${ruleLearned} ${successfulStrategy} ${rootCause ?? ''}`,
		files
	)

	return {
		id,
		createdAt,
		repo: turn.repo,
		taskType: turn.taskType,
		taskSummary: taskSummary || 'Codebase modification and verification',
		symptoms: symptoms.length > 0 ? symptoms : undefined,
		rootCause,
		successfulStrategy,
		ruleLearned,
		tags,
		files,
		confidence: turn.verificationPassed ? 0.95 : 0.6
	}
}
