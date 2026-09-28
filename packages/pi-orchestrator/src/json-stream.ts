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
		return { activity: formatToolActivity(name, evt.args) }
	}
	if (type === 'tool_execution_end') {
		const name = String(evt.toolName ?? 'tool')
		if (evt.isError) return { activity: `Failed ${name}` }
		return { activity: `Completed ${name}` }
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

export function formatToolActivity(name: string, args: unknown): string {
	const input =
		args && typeof args === 'object' && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: {}
	const path = typeof input.path === 'string' ? shortPath(input.path) : ''
	const location = [
		typeof input.offset === 'number' ? `from line ${input.offset}` : '',
		typeof input.limit === 'number' ? `${input.limit} lines` : ''
	]
		.filter(Boolean)
		.join(', ')

	switch (name) {
		case 'read':
			return `Read ${path || 'file'}${location ? ` · ${location}` : ''}`
		case 'write':
			return `Write ${path || 'file'}`
		case 'edit':
			return `Edit ${path || 'file'}`
		case 'bash':
			return `Run ${clip(String(input.command ?? 'command'), 100)}`
		case 'grep':
		case 'find':
			return `${name === 'grep' ? 'Search' : 'Find'} ${clip(String(input.pattern ?? 'files'), 70)}${path ? ` in ${path}` : ''}`
		case 'ls':
			return `List ${path || 'files'}`
		default: {
			const details = Object.entries(input)
				.filter(
					([key, value]) =>
						!['content', 'oldText', 'newText', 'prompt'].includes(key) &&
						value != null &&
						typeof value !== 'object'
				)
				.slice(0, 2)
				.map(([key, value]) => `${key}: ${clip(String(value), 48)}`)
			return `${name}${details.length ? ` · ${details.join(' · ')}` : ''}`
		}
	}
}

function shortPath(value: string): string {
	const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
	return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : value
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
