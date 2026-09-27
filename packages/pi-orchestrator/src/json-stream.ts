/** Split stdout into complete JSONL records. Returns leftover incomplete line. */
export function consumeJsonl(buffer: string, onRecord: (obj: unknown) => void): string {
	let start = 0
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] !== '\n') continue
		const line = buffer.slice(start, i).replace(/\r$/, '')
		start = i + 1
		if (!line.trim()) continue
		try {
			onRecord(JSON.parse(line))
		} catch {
			// Partial or non-JSON diagnostic leaked to stdout
		}
	}
	return buffer.slice(start)
}

export function textFromMessageContent(content: unknown): string {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	const parts: string[] = []
	for (const part of content) {
		if (!part || typeof part !== 'object') continue
		const p = part as Record<string, unknown>
		if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
	}
	return parts.join('')
}

export function summarizeJsonEvent(evt: Record<string, unknown>): {
	activity?: string
	assistantDelta?: string
	assistantFinal?: string
} {
	const type = evt.type
	if (type === 'message_update') {
		const inner = evt.assistantMessageEvent as Record<string, unknown> | undefined
		if (!inner || typeof inner.type !== 'string') return {}
		switch (inner.type) {
			case 'thinking_start':
				return { activity: '💭 thinking…' }
			case 'thinking_delta':
				return {
					activity: `💭 ${clip(String(inner.delta ?? ''), 80)}`
				}
			case 'thinking_end':
				return { activity: '💭 thinking done' }
			case 'text_delta':
				return {
					activity: `✍️ ${clip(String(inner.delta ?? ''), 90)}`,
					assistantDelta: String(inner.delta ?? '')
				}
			case 'text_end':
				return {
					activity: `✍️ ${clip(String(inner.content ?? ''), 90)}`,
					assistantFinal: String(inner.content ?? '')
				}
			case 'toolcall_start':
				return { activity: `🔧 ${inner.toolName ?? 'tool'}…` }
			case 'toolcall_end': {
				const tc = inner.toolCall as Record<string, unknown> | undefined
				const name = (tc?.name || inner.toolName || 'tool') as string
				return { activity: `🔧 ${name}(${clip(JSON.stringify(tc?.arguments ?? {}), 60)})` }
			}
			default:
				return {}
		}
	}
	if (type === 'tool_execution_start') {
		const name = String(evt.toolName ?? 'tool')
		const args = clip(JSON.stringify(evt.args ?? {}), 70)
		return { activity: `▶ ${name} ${args}` }
	}
	if (type === 'tool_execution_end') {
		const name = String(evt.toolName ?? 'tool')
		const err = evt.isError ? ' failed' : ''
		return { activity: `✓ ${name}${err}` }
	}
	if (type === 'message_end') {
		const msg = evt.message as Record<string, unknown> | undefined
		if (msg?.role === 'assistant') {
			const text = textFromMessageContent(msg.content)
			if (text.trim()) return { assistantFinal: text }
		}
	}
	if (type === 'agent_start' || type === 'turn_start') {
		return { activity: '⏳ model turn started' }
	}
	return {}
}

function clip(s: string, n: number): string {
	const t = s.replace(/\s+/g, ' ').trim()
	if (t.length <= n) return t
	return `${t.slice(0, n - 1)}…`
}
