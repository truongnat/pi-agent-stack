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
	/** input + output of one finished assistant message */
	tokens?: number
} {
	const type = evt.type
	if (type === 'message_update') {
		const inner = evt.assistantMessageEvent as Record<string, unknown> | undefined
		if (!inner || typeof inner.type !== 'string') return {}
		switch (inner.type) {
			case 'thinking_delta': {
				const delta = String(inner.delta ?? '').trim()
				if (delta.length < 24 && !delta.includes('**')) return {}
				return { activity: `💭 ${clip(delta, 80)}` }
			}
			case 'text_delta':
				return { assistantDelta: String(inner.delta ?? '') }
			case 'text_end': {
				const content = String(inner.content ?? '')
				const headline = firstHeadline(content)
				return {
					activity: headline ? `✍️ ${clip(headline, 90)}` : undefined,
					assistantFinal: content
				}
			}
			default:
				return {}
		}
	}
	if (type === 'tool_execution_start') {
		const name = String(evt.toolName ?? 'tool')
		const args = clip(JSON.stringify(evt.args ?? {}), 70)
		return { activity: `▶ \`${name}\` ${args}` }
	}
	if (type === 'tool_execution_end') {
		const name = String(evt.toolName ?? 'tool')
		if (evt.isError) return { activity: `✖ \`${name}\` failed` }
		return { activity: `✓ \`${name}\`` }
	}
	if (type === 'message_end') {
		const msg = evt.message as Record<string, unknown> | undefined
		if (msg?.role === 'assistant') {
			const text = textFromMessageContent(msg.content)
			const usage = msg.usage as { input?: number; output?: number } | undefined
			const tokens = (usage?.input ?? 0) + (usage?.output ?? 0)
			return {
				...(text.trim() ? { assistantFinal: text } : {}),
				...(tokens > 0 ? { tokens } : {})
			}
		}
	}
	if (type === 'turn_start') {
		return { activity: '⏳ new turn' }
	}
	return {}
}

function firstHeadline(content: string): string {
	for (const line of content.split('\n')) {
		const t = line.trim()
		if (t.startsWith('#')) return t.replace(/^#+\s*/, '')
		if (t.length >= 20) return t
	}
	return ''
}

function clip(s: string, n: number): string {
	const t = s.replace(/\s+/g, ' ').trim()
	if (t.length <= n) return t
	return `${t.slice(0, n - 1)}…`
}
