/**
 * Replace bulky `read` / `read_file` tool bodies with Tree-Sitter skeletons
 * from pi-core so DCP keeps signatures without paying for implementations.
 */
import { skeletonizeCode } from 'pi-native-bridge'
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from '../config.ts'
import {
	type AnyMessage,
	isAlreadyPlaceholder,
	isAssistant,
	isToolResult,
	toolCallsOf,
	toolResultTokens,
	type ToolResultMessage
} from '../messages.ts'
import type { SessionState } from '../state.ts'

const MIN_CHARS = 800
const SKELETON_MARK = '[skeleton by pi-dcp]'

export interface SkeletonizeResult {
	skeletonizedCount: number
	tokensSaved: number
}

function languageFromPath(path: string): string | null {
	const lower = path.toLowerCase()
	if (lower.endsWith('.rs')) return 'rust'
	if (lower.endsWith('.py')) return 'python'
	if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'tsx'
	if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript'
	if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript'
	if (lower.endsWith('.go')) return 'go'
	if (lower.endsWith('.java')) return 'java'
	if (lower.endsWith('.vue')) return 'vue'
	return null
}

function textOf(m: ToolResultMessage): string {
	return m.content
		.filter((c) => c.type === 'text' && typeof c.text === 'string')
		.map((c) => (c as { text: string }).text)
		.join('\n')
}

export function applySkeletonize(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	protectedByTurn: Set<string> = new Set()
): SkeletonizeResult {
	if (config.strategies.skeletonize?.enabled === false) {
		return { skeletonizedCount: 0, tokensSaved: 0 }
	}

	const protectedTools = new Set([...ALWAYS_PROTECTED_TOOLS, ...config.compress.protectedTools])
	const callIdToPath = new Map<string, string>()
	for (const m of messages) {
		if (!isAssistant(m)) continue
		for (const call of toolCallsOf(m)) {
			if (call.name !== 'read' && call.name !== 'read_file') continue
			const path = call.arguments?.path
			if (typeof path === 'string') callIdToPath.set(call.id, path)
		}
	}
	// The latest read of each file stays whole: the model edits against that text, and an
	// edit built from a skeleton fails to match.
	const latestReadOf = new Map<string, string>()
	for (const [callId, path] of callIdToPath) latestReadOf.set(path, callId)

	let skeletonizedCount = 0
	let tokensSaved = 0
	for (const m of messages) {
		if (!isToolResult(m)) continue
		if (protectedTools.has(m.toolName)) continue
		if (protectedByTurn.has(m.toolCallId)) continue
		if (isAlreadyPlaceholder(m)) continue
		if (m.toolName !== 'read' && m.toolName !== 'read_file') continue
		const path = callIdToPath.get(m.toolCallId)
		if (!path) continue
		if (latestReadOf.get(path) === m.toolCallId) continue
		const lang = languageFromPath(path)
		if (!lang) continue
		const source = textOf(m)
		if (source.length < MIN_CHARS) continue
		if (source.startsWith(SKELETON_MARK)) continue

		let skel: ReturnType<typeof skeletonizeCode>
		try {
			skel = skeletonizeCode(source, lang)
		} catch {
			// One unparsable file must not stop the rest of the pipeline.
			continue
		}
		if (skel.reduction_percentage < 15 || !skel.skeleton.trim()) continue

		const before = toolResultTokens(m)
		m.content = [
			{
				type: 'text',
				text: `${SKELETON_MARK} ${path} (−${skel.reduction_percentage}%)\n\n${skel.skeleton}`
			}
		]
		m.details = undefined
		if (state.skeletonizedIds.has(m.toolCallId)) continue
		state.skeletonizedIds.add(m.toolCallId)
		tokensSaved += Math.max(0, before - toolResultTokens(m))
		skeletonizedCount++
	}

	return { skeletonizedCount, tokensSaved }
}
