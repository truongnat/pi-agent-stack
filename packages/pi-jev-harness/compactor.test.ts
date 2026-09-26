import assert from 'node:assert/strict'
import test from 'node:test'

import {
	compactHistory,
	pruneBySyntaxBoundaries,
	summarizeToolOutput,
	verifyCachePrefixIntegrity,
	type ContextMessage
} from './compactor.ts'

test('verifyCachePrefixIntegrity detects volatile nonces, timestamps, and counters', () => {
	const cleanPrompt = 'You are an elite coding assistant. Follow clean code principles.'
	const checkClean = verifyCachePrefixIntegrity(cleanPrompt)
	assert.equal(checkClean.isDeterministic, true)
	assert.equal(checkClean.violations.length, 0)

	const promptWithIso = 'System Instruction. Current time: 2026-09-26T12:30:00Z. Answer nicely.'
	const checkIso = verifyCachePrefixIntegrity(promptWithIso)
	assert.equal(checkIso.isDeterministic, false)
	assert.match(checkIso.violations[0] ?? '', /ISO timestamp/)

	const promptWithNonce = 'Session nonce: 12345678-1234-1234-1234-123456789abc. Run.'
	const checkNonce = verifyCachePrefixIntegrity(promptWithNonce)
	assert.equal(checkNonce.isDeterministic, false)
	assert.match(checkNonce.violations[0] ?? '', /UUID nonce/)

	const promptWithTurn = 'Instructions. Current Turn: 5. Proceed.'
	const checkTurn = verifyCachePrefixIntegrity(promptWithTurn)
	assert.equal(checkTurn.isDeterministic, false)
	assert.match(checkTurn.violations[0] ?? '', /turn counter/)
})

test('pruneBySyntaxBoundaries cleanly truncates at diff hunks, block ends, and newlines', () => {
	const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
@@ -10,5 +10,6 @@
 function foo() {
-  return 1;
+  return 2;
 }
@@ -30,5 +30,6 @@
 function bar() {
   return 3;
 }`

	const pruned = pruneBySyntaxBoundaries(sampleDiff, 80)
	assert.ok(pruned.length <= 80)
	assert.ok(
		!pruned.endsWith(
			'diff --git a/src/index.ts b/src/index.ts\n@@ -10,5 +10,6 @@\nfunction foo() {\n-  return 1;\n+  ret'
		)
	)
})

test('summarizeToolOutput generates high-density semantic summaries', () => {
	const testLog =
		'Running test suite...\n✓ test foo [2ms]\n✓ test bar [1ms]\n8 passed, 0 failed\nRan 8 tests'
	const testSum = summarizeToolOutput('bash', testLog)
	assert.match(testSum, /Test executed/)
	assert.match(testSum, /8 passed, 0 failed/)

	const diffLog =
		'diff --git a/src/a.ts b/src/a.ts\n+added line\ndiff --git a/src/b.ts b/src/b.ts\n-removed line'
	const diffSum = summarizeToolOutput('bash', diffLog)
	assert.match(diffSum, /Diff summary/)
	assert.match(diffSum, /a\.ts, b\.ts/)

	const readLog = 'export function hello() {\n  return "world";\n}\n// 200 lines follow...'
	const readSum = summarizeToolOutput('read', readLog)
	assert.match(readSum, /Read excerpt/)
	assert.match(readSum, /export function hello/)
})

test('compactHistory compresses bulky historical turns while preserving system & recent anchors', () => {
	const largeBulkyOutput = 'A'.repeat(5000)
	const messages: ContextMessage[] = [
		{ role: 'system', content: 'System instruction prefix (must stay intact).' },
		{ role: 'user', content: 'Turn 1: please check tests' },
		{
			role: 'tool',
			content: `Test result:\n${largeBulkyOutput}\n8 passed, 0 failed`,
			customType: 'bash'
		},
		{ role: 'assistant', content: 'Tests passed. Now refactoring.' },
		{ role: 'user', content: 'Turn 2: recent anchor query' },
		{ role: 'tool', content: 'Recent quick result: OK', customType: 'bash' },
		{ role: 'assistant', content: 'Finished.' }
	]

	const { compacted, charsSaved, compactedCount } = compactHistory(messages, {
		thresholdChars: 2000,
		recentAnchorTurns: 1,
		maxMiddleResultChars: 500,
		enableSpill: false
	})

	assert.equal(compactedCount, 1)
	assert.ok(charsSaved > 4000)

	// System message must remain completely unchanged
	assert.equal(compacted[0]?.content, 'System instruction prefix (must stay intact).')

	// Middle bulky tool result (index 2) must be compacted
	assert.match(compacted[2]?.content as string, /\[ 🗜 Compactor:/)
	assert.ok(((compacted[2]?.content as string) || '').length < 800)

	// Recent anchor turns (indices 4, 5, 6) must remain untouched
	assert.equal(compacted[5]?.content, 'Recent quick result: OK')
})
