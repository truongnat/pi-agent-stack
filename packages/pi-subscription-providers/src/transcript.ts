import {
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type TranscriptContext
} from '@earendil-works/pi-ai'

/** Build a compact text prompt for CLI compatibility mode (no native Pi tool wire). */
export function buildCliPrompt(context: TranscriptContext): string {
	const transcript = collapseSystemMessages(context)
	const system = getCurrentSystemPrompt(transcript.messages)
	const tools = getCurrentTools(transcript.messages)
	const parts: string[] = []
	if (system.trim()) {
		parts.push(`System:\n${system.trim()}`)
	}
	if (tools.length) {
		parts.push(
			[
				'Note: This provider runs in compatibility mode.',
				'Native Pi tool-call semantics are not available.',
				'Pi tools remain owned by Pi; answer using the conversation only.',
				`Active Pi tools (informational): ${tools.map((tool) => tool.name).join(', ')}`
			].join(' ')
		)
	}
	parts.push('Conversation:')
	for (const message of transcript.messages) {
		parts.push(formatMessage(message))
	}
	parts.push('Respond as the assistant. Do not invent tool-call JSON for Pi.')
	return parts.join('\n\n')
}

function formatMessage(message: Message): string {
	if (message.role === 'user') {
		if (typeof message.content === 'string') return `user: ${message.content}`
		const text = message.content
			.filter((block) => block.type === 'text')
			.map((block) => (block.type === 'text' ? block.text : ''))
			.join('\n')
		return `user: ${text}`
	}
	if (message.role === 'assistant') {
		const text = message.content
			.map((block) => {
				if (block.type === 'text') return block.text
				if (block.type === 'thinking') return `(thinking) ${block.thinking}`
				if (block.type === 'toolCall') return `(toolCall ${block.name})`
				return ''
			})
			.filter(Boolean)
			.join('\n')
		return `assistant: ${text}`
	}
	if (message.role === 'toolResult') {
		const text = message.content
			.filter((block) => block.type === 'text')
			.map((block) => (block.type === 'text' ? block.text : ''))
			.join('\n')
		return `toolResult(${message.toolName}): ${text.slice(0, 2_000)}`
	}
	return ''
}
