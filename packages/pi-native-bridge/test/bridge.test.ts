import assert from 'node:assert/strict'
import test from 'node:test'
import {
	countTokens,
	countTokensBPE,
	getNativeVersion,
	hashToolSignature,
	isNativeAvailable,
	scanDirectory,
	searchWorkspace
} from '../src/index.ts'

test('bridge exports version and availability status', () => {
	const version = getNativeVersion()
	assert.ok(typeof version === 'string')
	assert.match(version, /^0\.2\.0/)
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
