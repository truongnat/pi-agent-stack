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
	if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'typescript'
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
	_state: SessionState,
	protectedByTurn: Set<string> = new Set()
): SkeletonizeResult {
	if (!config.strategies.deduplication.enabled) {
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
		const lang = languageFromPath(path)
		if (!lang) continue
		const source = textOf(m)
		if (source.length < MIN_CHARS) continue
		if (source.startsWith(SKELETON_MARK)) continue

		const skel = skeletonizeCode(source, lang)
		if (skel.reduction_percentage < 15 || !skel.skeleton.trim()) continue

		const before = toolResultTokens(m)
		m.content = [
			{
				type: 'text',
				text: `${SKELETON_MARK} ${path} (−${skel.reduction_percentage}%)\n\n${skel.skeleton}`
			}
		]
		m.details = undefined
		tokensSaved += Math.max(0, before - toolResultTokens(m))
		skeletonizedCount++
	}

	return { skeletonizedCount, tokensSaved }
}
