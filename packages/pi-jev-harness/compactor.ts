/**
 * compactor.ts: Dynamic Context Compactor & Cache-Aware Prefix Preservation.
 *
 * Implements:
 * 1. Selective Middle-Turn Compaction: Compresses bulky historical tool results while preserving recent turns.
 * 2. Syntax-Aware Structural Pruning: Cuts code/diffs at natural syntax boundaries (diff hunks, functions, lines).
 * 3. Cache-Aware Prefix Verification: Enforces deterministic static system prompts to maximize LLM prompt cache hits.
 * 4. Spill-backed Lossless Storage: Retains raw truncated outputs on disk for deterministic recovery.
 */
import { basename } from 'node:path'
import { fingerprintPrompt, skeletonizeCode } from 'pi-native-bridge'

import { spill, spillHint } from './spill.ts'

export interface MessagePart {
	type: string
	text?: string
	[key: string]: unknown
}

export interface ContextMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | MessagePart[]
	customType?: string
	display?: boolean
	[key: string]: unknown
}

export interface CompactorOptions {
	/** Minimum total characters before compaction triggers */
	thresholdChars?: number
	/** Number of most recent turns to anchor (leave completely untouched) */
	recentAnchorTurns?: number
	/** Maximum characters to retain for a single middle-turn tool result */
	maxMiddleResultChars?: number
	/** Whether to spill truncated raw text to disk */
	enableSpill?: boolean
}

const DEFAULT_OPTIONS: Required<CompactorOptions> = {
	thresholdChars: 24_000,
	recentAnchorTurns: 3,
	maxMiddleResultChars: 800,
	enableSpill: true
}

/**
 * Checks if a system prompt contains volatile dynamic tokens (timestamps, random nonces, turn counters)
 * that would invalidate LLM prefix prompt caching.
 */
export function verifyCachePrefixIntegrity(systemPrompt: string): {
	isDeterministic: boolean
	violations: string[]
	fingerprint: string
} {
	const violations: string[] = []

	// 1. ISO Timestamps / Dynamic Dates (e.g. 2026-09-26T12:30:00Z)
	if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(systemPrompt)) {
		violations.push('Dynamic ISO timestamp detected in system prompt')
	}

	// 2. Random UUIDs or Hex nonces in header
	if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(systemPrompt)) {
		violations.push('Dynamic UUID nonce detected in system prompt')
	}

	// 3. Dynamic turn counters (e.g. "Current Turn: 12")
	if (/\b(?:current\s+turn|turn\s+count|turn\s*#)\s*:\s*\d+/i.test(systemPrompt)) {
		violations.push('Dynamic turn counter detected in system prompt header')
	}

	return {
		isDeterministic: violations.length === 0,
		violations,
		fingerprint: fingerprintPrompt(systemPrompt)
	}
}

/**
 * Prunes code or diff outputs cleanly at natural structural boundaries
 * (diff hunk markers, class/function blocks, or clean newlines) rather than arbitrary byte boundaries.
 */
function guessSourceLanguage(text: string): string | null {
	if (/\b(fn |pub struct |impl |mod )/.test(text)) return 'rust'
	if (/\bdef |class .+:/.test(text) && !text.includes('function ')) return 'python'
	if (/\b(export |function |const |interface |type )/.test(text)) return 'typescript'
	return null
}

export function pruneBySyntaxBoundaries(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text

	const slice = text.slice(0, maxChars)

	// 1. Check for diff hunk boundary (@@ ... @@)
	const lastHunk = slice.lastIndexOf('\n@@')
	if (lastHunk > maxChars * 0.6) {
		return slice.slice(0, lastHunk)
	}

	// 2. Check for function / block closure boundary
	const lastBlockClose = slice.lastIndexOf('\n}')
	if (lastBlockClose > maxChars * 0.6) {
		return slice.slice(0, lastBlockClose + 2)
	}

	// 3. Check for natural newline boundary
	const lastNewline = slice.lastIndexOf('\n')
	if (lastNewline > maxChars * 0.5) {
		return slice.slice(0, lastNewline)
	}

	return slice
}

/**
 * Extracts a concise semantic summary of a tool result content.
 */
export function summarizeToolOutput(toolName: string, text: string): string {
	const trimmed = text.trim()
	const lines = trimmed
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)

	// Test output summary
	if (trimmed.includes('pass') || trimmed.includes('fail') || trimmed.includes('test')) {
		const summaryLine = lines.find((l) => /\b(\d+\s+pass|\d+\s+fail|passed|failed|Tests:)/i.test(l))
		if (summaryLine) {
			return `[ 🗜 Compactor: Test executed -> ${summaryLine} ]`
		}
	}

	// Git diff summary
	if (trimmed.includes('diff --git') || trimmed.includes('@@')) {
		const changedFiles: string[] = []
		for (const m of trimmed.matchAll(/diff --git a\/(.+?) b\//g)) {
			if (m[1]) changedFiles.push(basename(m[1]))
		}
		if (changedFiles.length > 0) {
			return `[ 🗜 Compactor: Diff summary -> ${changedFiles.join(', ')} (${lines.length} lines) ]`
		}
	}

	// File read summary — Tree-Sitter skeleton when it actually shrinks the body
	if (toolName === 'read' || toolName === 'view_file' || toolName === 'read_file') {
		const lang = guessSourceLanguage(trimmed)
		if (lang && trimmed.length >= 400) {
			try {
				const skel = skeletonizeCode(trimmed, lang)
				if (skel.reduction_percentage >= 15 && skel.skeleton.trim()) {
					return `[ 🗜 Compactor: skeleton −${skel.reduction_percentage}%]\n${skel.skeleton}`
				}
			} catch {
				// fall through to excerpt
			}
		}
		const firstLine = lines[0] || 'file content'
		return `[ 🗜 Compactor: Read excerpt (${lines.length} lines): ${firstLine.slice(0, 100)} ]`
	}

	// Generic command output
	const sample = lines.slice(0, 2).join('; ')
	return `[ 🗜 Compactor: ${toolName} output (${lines.length} lines): ${sample.slice(0, 120)}... ]`
}

/**
 * Performs selective compaction across a message trajectory:
 * - Leaves system messages and the last N turns untouched.
 * - Compacts bulky historical tool results into structured summaries.
 */
export function compactHistory(
	messages: ContextMessage[],
	opts?: CompactorOptions
): {
	compacted: ContextMessage[]
	charsSaved: number
	compactedCount: number
} {
	const options = { ...DEFAULT_OPTIONS, ...opts }
	let totalChars = 0

	for (const msg of messages) {
		if (typeof msg.content === 'string') {
			totalChars += msg.content.length
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				totalChars += part.text?.length ?? 0
			}
		}
	}

	if (totalChars < options.thresholdChars) {
		return { compacted: messages, charsSaved: 0, compactedCount: 0 }
	}

	let charsSaved = 0
	let compactedCount = 0

	// Determine cut-off point for recent anchor turns
	const anchorIndex = Math.max(0, messages.length - options.recentAnchorTurns * 2)

	const compacted: ContextMessage[] = messages.map((msg, idx) => {
		// Never touch system messages or recent anchor turns
		if (msg.role === 'system' || idx >= anchorIndex) {
			return msg
		}

		// Check if message contains large tool result text
		if (typeof msg.content === 'string') {
			if (msg.content.length > options.maxMiddleResultChars) {
				const toolName = (msg.customType || (msg as any).name || 'tool') as string
				const raw = msg.content
				const savedPath = options.enableSpill ? spill(raw, toolName) : undefined
				const recoverHint = savedPath ? ` ${spillHint(savedPath)}` : ''

				const summary = summarizeToolOutput(toolName, raw)
				const prunedHead = pruneBySyntaxBoundaries(raw, options.maxMiddleResultChars / 2)
				const newText = `${prunedHead}\n\n${summary}${recoverHint}`

				charsSaved += raw.length - newText.length
				compactedCount++
				return { ...msg, content: newText }
			}
		} else if (Array.isArray(msg.content)) {
			let modified = false
			const newParts = msg.content.map((part) => {
				if (part.type === 'text' && part.text && part.text.length > options.maxMiddleResultChars) {
					const raw = part.text
					const savedPath = options.enableSpill ? spill(raw, 'tool_part') : undefined
					const recoverHint = savedPath ? ` ${spillHint(savedPath)}` : ''

					const summary = summarizeToolOutput('tool', raw)
					const prunedHead = pruneBySyntaxBoundaries(raw, options.maxMiddleResultChars / 2)
					const newText = `${prunedHead}\n\n${summary}${recoverHint}`

					charsSaved += raw.length - newText.length
					compactedCount++
					modified = true
					return { ...part, text: newText }
				}
				return part
			})

			if (modified) {
				return { ...msg, content: newParts }
			}
		}

		return msg
	})

	return {
		compacted,
		charsSaved,
		compactedCount
	}
}
