import {
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type TranscriptContext
} from '@earendil-works/pi-ai'

/** Max chars for single CLI argument to stay well within Linux MAX_ARG_STRLEN (128 KB). */
export const MAX_CLI_PROMPT_CHARS = 90_000

/** Build a compact text prompt for CLI compatibility mode (no native Pi tool wire). */
export function buildCliPrompt(context: TranscriptContext, maxChars: number = MAX_CLI_PROMPT_CHARS): string {
	const transcript = collapseSystemMessages(context)
	const rawSystem = getCurrentSystemPrompt(transcript.messages)
	const system =
		rawSystem.length > 8_000 ? `${rawSystem.slice(0, 8_000)}\n[...system prompt truncated...]` : rawSystem
	const tools = getCurrentTools(transcript.messages)
	const headerParts: string[] = []
	if (system.trim()) {
		headerParts.push(`System:\n${system.trim()}`)
	}
	if (tools.length) {
		headerParts.push(
			[
				'Note: This provider runs in compatibility mode.',
				'Native Pi tool-call semantics are not available.',
				'Pi tools remain owned by Pi; answer using the conversation only.',
				`Active Pi tools (informational): ${tools.map((tool) => tool.name).join(', ')}`
			].join(' ')
		)
	}
	headerParts.push('Conversation:')
	const header = headerParts.join('\n\n')
	const footer = '\n\nRespond as the assistant. Do not invent tool-call JSON for Pi.'

	const budgetForMessages = Math.max(10_000, maxChars - header.length - footer.length)

	const formattedMessages: string[] = []
	let usedChars = 0
	let truncated = false

	for (let i = transcript.messages.length - 1; i >= 0; i--) {
		const formatted = formatMessage(transcript.messages[i])
		if (!formatted) continue
		if (usedChars + formatted.length + 2 > budgetForMessages && formattedMessages.length > 0) {
			truncated = true
			break
		}
		formattedMessages.unshift(formatted)
		usedChars += formatted.length + 2
	}

	if (truncated) {
		formattedMessages.unshift('[... earlier conversation truncated for CLI compatibility ...]')
	}

	return `${header}\n\n${formattedMessages.join('\n\n')}${footer}`
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
				if (block.type === 'thinking') return `(thinking) ${block.thinking.slice(0, 500)}`
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
		return `toolResult(${message.toolName}): ${text.slice(0, 1_000)}`
	}
	return ''
}
