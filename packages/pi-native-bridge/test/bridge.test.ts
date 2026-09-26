import assert from 'node:assert/strict'
import test from 'node:test'
import {
	countTokens,
	getNativeVersion,
	hashToolSignature,
	isNativeAvailable,
	scanDirectory
} from '../src/index.ts'

test('bridge exports version and availability status', () => {
	const version = getNativeVersion()
	assert.ok(typeof version === 'string')
	assert.match(version, /^0\.1\.0/)
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

test('hashToolSignature produces deterministic hex signatures', () => {
	const h1 = hashToolSignature('read_file', '{"path":"/index.ts"}')
	const h2 = hashToolSignature('read_file', '{"path":"/index.ts"}')
	const h3 = hashToolSignature('read_file', '{"path":"/other.ts"}')

	assert.equal(h1, h2)
	assert.notEqual(h1, h3)
	assert.ok(h1.length > 0)
})

test('scanDirectory scans filesystem paths and filters ignored folders', () => {
	const currentDir = process.cwd()
	const entries = scanDirectory(currentDir, 2)

	assert.ok(Array.isArray(entries))
	if (entries.length > 0) {
		const paths = entries.map((e) => e.path)
		assert.ok(paths.some((p) => p.includes('package.json') || p.includes('packages')))
		assert.ok(!paths.some((p) => p.startsWith('node_modules') || p.startsWith('.git')))
	}
})
