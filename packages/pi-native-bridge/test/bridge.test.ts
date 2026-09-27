import assert from 'node:assert/strict'
import test from 'node:test'
import {
	countTokens,
	countTokensBPE,
	getNativeVersion,
	fingerprintPrompt,
	hashToolSignature,
	isNativeAvailable,
	isProcessAlive,
	rankDocuments,
	scanDirectory,
	searchWorkspace,
	skeletonizeCode,
	spawnSupervised,
	trigramSimilarity,
	vectorCosineSimilarity
} from '../src/index.ts'

test('bridge exports version and availability status', () => {
	const version = getNativeVersion()
	assert.ok(typeof version === 'string')
	assert.match(version, /^0\.5\.0/)
	assert.equal(typeof isNativeAvailable(), 'boolean')
})

test('countTokens calculates tokens for code and text', () => {
	const countEmpty = countTokens('')
	assert.equal(countEmpty, 0)

	const countSimple = countTokens('Hello world! Fast Rust token bridge.', 'openai')
	assert.ok(countSimple >= 6 && countSimple <= 15, `Actual count: ${countSimple}`)

	const codeSnippet = 'export function add(a: number, b: number): number { return a + b; }'
	const countCode = countTokens(codeSnippet, 'anthropic')
	assert.ok(countCode >= 10 && countCode <= 30, `Actual count: ${countCode}`)
})

test('countTokensBPE computes exact byte-pair tokens', () => {
	const countEmpty = countTokensBPE('')
	assert.equal(countEmpty, 0)

	const countO200k = countTokensBPE(
		'const result = computeMetrics(data, { window: 60 });',
		'o200k_base'
	)
	assert.ok(countO200k > 5 && countO200k < 25, `Actual o200k count: ${countO200k}`)

	const countCl100k = countTokensBPE(
		'const result = computeMetrics(data, { window: 60 });',
		'cl100k_base'
	)
	assert.ok(countCl100k > 5 && countCl100k < 25, `Actual cl100k count: ${countCl100k}`)
})

test('fingerprintPrompt is stable for the same system prefix', () => {
	const a = fingerprintPrompt('You are a coding agent.')
	const b = fingerprintPrompt('You are a coding agent.')
	const c = fingerprintPrompt('You are a coding agent. Turn: 2')
	assert.equal(a, b)
	assert.notEqual(a, c)
})

test('hashToolSignature produces deterministic hex signatures', () => {
	const h1 = hashToolSignature('read_file', '{"path":"/index.ts"}')
	const h2 = hashToolSignature('read_file', '{"path":"/index.ts"}')
	const h3 = hashToolSignature('read_file', '{"path":"/other.ts"}')

	assert.equal(h1, h2)
	assert.notEqual(h1, h3)
	assert.ok(h1.length > 0)
})

test('scanDirectory scans filesystem paths and filters ignored folders with Ripgrep', () => {
	const currentDir = process.cwd()
	const entries = scanDirectory(currentDir, 2)

	assert.ok(Array.isArray(entries))
	if (entries.length > 0) {
		const paths = entries.map((e) => e.path)
		assert.ok(paths.some((p) => p.includes('package.json') || p.includes('packages')))
		assert.ok(
			!paths.some(
				(p) =>
					p.startsWith('node_modules') ||
					p.startsWith('.git') ||
					p.startsWith('crates/pi-core/target')
			)
		)
	}
})

test('searchWorkspace finds matching lines in parallel', () => {
	const currentDir = process.cwd()
	const matches = searchWorkspace(currentDir, 'pi-agent-stack', 10)

	assert.ok(Array.isArray(matches))
	assert.ok(matches.length > 0, 'Should find pi-agent-stack in repository')
	assert.ok(matches[0].path.length > 0)
	assert.ok(matches[0].line_number > 0)
})

test('skeletonizeCode strips implementation bodies via Tree-Sitter AST', () => {
	const tsCode = `
import { Config } from './types.ts'

export interface StateData {
	id: string
	count: number
}

export function heavyProcessor(input: StateData, factor: number): number {
	const temp = factor * 2;
	let acc = 0;
	for (let i = 0; i < 1000; i++) {
		acc += temp + i;
	}
	return acc;
}
`
	const res = skeletonizeCode(tsCode, 'ts')
	assert.ok(res.reduction_percentage > 20, `Reduction was: ${res.reduction_percentage}%`)
	assert.ok(res.skeleton.includes('interface StateData'))
	assert.ok(res.skeleton.includes('heavyProcessor'))
	assert.ok(!res.skeleton.includes('const temp = factor * 2'))
})

test('spawnSupervised executes command and handles timeout with process group kill', () => {
	const resFast = spawnSupervised("echo 'supervisor-ok'", process.cwd(), 5000)
	assert.equal(resFast.exit_code, 0)
	assert.ok(resFast.stdout.includes('supervisor-ok'))
	assert.equal(resFast.timed_out, false)

	const resTimeout = spawnSupervised('sleep 3', process.cwd(), 200)
	assert.equal(resTimeout.timed_out, true)
	assert.ok(resTimeout.exit_code !== 0)

	assert.equal(isProcessAlive(process.pid), true)
})

test('vectorCosineSimilarity computes accurate dot products', () => {
	const vec1 = [1.0, 0.0, 1.0]
	const vec2 = [1.0, 0.0, 1.0]
	const sim = vectorCosineSimilarity(vec1, vec2)
	assert.ok(Math.abs(sim - 1.0) < 0.001)

	const vec3 = [0.0, 1.0, 0.0]
	const simOrtho = vectorCosineSimilarity(vec1, vec3)
	assert.ok(Math.abs(simOrtho) < 0.001)
})

test('trigramSimilarity and rankDocuments rank relevant memory lessons', () => {
	const sim = trigramSimilarity('calculateInterest()', 'calculateInterest')
	assert.ok(sim > 0.6)

	const docs = [
		{
			id: '1',
			text: 'Always run bun test before pushing code',
			tags: ['test', 'bun'],
			utility: 0.9
		},
		{ id: '2', text: 'Database migrations must be deterministic', tags: ['db'], utility: 0.5 },
		{ id: '3', text: 'Run prettier on formatted files', tags: ['lint'], utility: 0.7 }
	]

	const ranked = rankDocuments('how do I run bun test', docs, 2)
	assert.equal(ranked.length, 2)
	assert.equal(ranked[0].id, '1')
	assert.ok(ranked[0].score > ranked[1].score)
})
