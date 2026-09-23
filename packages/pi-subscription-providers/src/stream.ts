import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TranscriptContext
} from '@earendil-works/pi-ai'

import { loadConfig, providerConfig } from './config.ts'
import { runStreamingLines } from './line-stream.ts'
import { diagnostic, redact, redactError } from './redact.ts'
import { buildCliPrompt } from './transcript.ts'
import type { Readiness } from './types.ts'

function doneReason(stopReason: StopReason): Exclude<StopReason, 'error' | 'aborted' | 'pending'> {
	if (
		stopReason === 'stop' ||
		stopReason === 'length' ||
		stopReason === 'toolUse' ||
		stopReason === 'deferred'
	) {
		return stopReason
	}
	return 'stop'
}

export type LineRunner = typeof runStreamingLines

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		},
		stopReason: 'pending',
		timestamp: Date.now()
	}
}

function applyUsage(
	model: Model<Api>,
	output: AssistantMessage,
	usage: {
		input?: number | undefined
		output?: number | undefined
		cacheRead?: number | undefined
		cacheWrite?: number | undefined
	}
): void {
	if (usage.input !== undefined) output.usage.input = usage.input
	if (usage.output !== undefined) output.usage.output = usage.output
	if (usage.cacheRead !== undefined) output.usage.cacheRead = usage.cacheRead
	if (usage.cacheWrite !== undefined) output.usage.cacheWrite = usage.cacheWrite
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite
	calculateCost(model, output.usage)
}

function ensureText(output: AssistantMessage, stream: AssistantMessageEventStream): number {
	const index = output.content.findIndex((block) => block.type === 'text')
	if (index >= 0) return index
	output.content.push({ type: 'text', text: '' })
	const next = output.content.length - 1
	stream.push({ type: 'text_start', contentIndex: next, partial: output })
	return next
}

function ensureThinking(output: AssistantMessage, stream: AssistantMessageEventStream): number {
	const index = output.content.findIndex((block) => block.type === 'thinking')
	if (index >= 0) return index
	output.content.push({ type: 'thinking', thinking: '' })
	const next = output.content.length - 1
	stream.push({ type: 'thinking_start', contentIndex: next, partial: output })
	return next
}

function appendText(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	delta: string
): void {
	if (!delta) return
	const index = ensureText(output, stream)
	const block = output.content[index]
	if (!block || block.type !== 'text') return
	block.text += delta
	stream.push({ type: 'text_delta', contentIndex: index, delta, partial: output })
}

function appendThinking(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	delta: string
): void {
	if (!delta) return
	const index = ensureThinking(output, stream)
	const block = output.content[index]
	if (!block || block.type !== 'thinking') return
	block.thinking += delta
	stream.push({ type: 'thinking_delta', contentIndex: index, delta, partial: output })
}

function closeOpenBlocks(output: AssistantMessage, stream: AssistantMessageEventStream): void {
	output.content.forEach((block, index) => {
		if (block.type === 'text') {
			stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: output })
		} else if (block.type === 'thinking') {
			stream.push({
				type: 'thinking_end',
				contentIndex: index,
				content: block.thinking,
				partial: output
			})
		}
	})
}

function hasText(output: AssistantMessage): boolean {
	return output.content.some((block) => block.type === 'text' && block.text.length > 0)
}

function handleCursorLine(
	line: string,
	model: Model<Api>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream
): void {
	let event: unknown
	try {
		event = JSON.parse(line)
	} catch {
		return
	}
	if (!event || typeof event !== 'object') return
	const row = event as Record<string, unknown>
	const type = row.type
	if (type === 'thinking' && row.subtype === 'delta' && typeof row.text === 'string') {
		appendThinking(output, stream, row.text)
		return
	}
	if (type === 'assistant' && row.message && typeof row.message === 'object') {
		const message = row.message as { content?: Array<{ type?: string; text?: string }> }
		for (const block of message.content ?? []) {
			if (block.type === 'text' && block.text) appendText(output, stream, block.text)
		}
		return
	}
	if (type === 'result') {
		const usage =
			row.usage && typeof row.usage === 'object'
				? (row.usage as {
						inputTokens?: number
						outputTokens?: number
						cacheReadTokens?: number
						cacheWriteTokens?: number
					})
				: undefined
		if (usage) {
			applyUsage(model, output, {
				input: usage.inputTokens,
				output: usage.outputTokens,
				cacheRead: usage.cacheReadTokens,
				cacheWrite: usage.cacheWriteTokens
			})
		}
		if (row.subtype === 'success' && typeof row.result === 'string' && !hasText(output)) {
			appendText(output, stream, row.result)
		}
		if (row.is_error === true) {
			output.stopReason = 'error'
			output.errorMessage = redact(
				diagnostic(typeof row.result === 'string' ? row.result : 'cursor error')
			)
		} else {
			output.stopReason = 'stop'
		}
	}
}

function handleAgyLine(
	line: string,
	model: Model<Api>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream
): void {
	let event: unknown
	try {
		event = JSON.parse(line)
	} catch {
		return
	}
	if (!event || typeof event !== 'object') return
	const row = event as Record<string, unknown>
	if (row.event === 'step_update' && row.step_update && typeof row.step_update === 'object') {
		const step = row.step_update as {
			step_type?: string
			text_delta?: string
			usage?: {
				input_tokens?: number
				output_tokens?: number
				cache_read_tokens?: number
			}
		}
		if (step.step_type === 'agent_response' && step.text_delta) {
			appendText(output, stream, step.text_delta)
		}
		if (step.usage) {
			applyUsage(model, output, {
				input: step.usage.input_tokens,
				output: step.usage.output_tokens,
				cacheRead: step.usage.cache_read_tokens
			})
		}
		return
	}
	if (row.event === 'result' && row.result && typeof row.result === 'object') {
		const result = row.result as {
			status?: string
			response?: string
			usage?: {
				input_tokens?: number
				output_tokens?: number
				cache_read_tokens?: number
			}
		}
		if (result.usage) {
			applyUsage(model, output, {
				input: result.usage.input_tokens,
				output: result.usage.output_tokens,
				cacheRead: result.usage.cache_read_tokens
			})
		}
		if (result.response && !hasText(output)) appendText(output, stream, result.response)
		output.stopReason = result.status === 'SUCCESS' ? 'stop' : 'error'
		if (output.stopReason === 'error') {
			output.errorMessage = 'antigravity result status was not SUCCESS'
		}
	}
}

export function streamCursorCli(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	readiness: Readiness,
	lineRunner: LineRunner = runStreamingLines
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream()
	const cfg = providerConfig(loadConfig(), 'cursor')
	void (async () => {
		const output = createOutput(model)
		try {
			if (!readiness.ready || !readiness.command) {
				throw new Error(`cursor provider_not_ready: ${readiness.reason}`)
			}
			const prompt = buildCliPrompt(context)
			const payload = { prompt, model: model.id, provider: 'cursor', mode: 'compatibility' }
			const replacement = options?.onPayload ? await options.onPayload(payload, model) : payload
			const finalPayload =
				replacement && typeof replacement === 'object'
					? (replacement as { prompt?: string; model?: string })
					: payload
			await options?.onResponse?.({ status: 200, headers: {} }, model)
			stream.push({ type: 'start', partial: output })

			const result = await lineRunner({
				command: readiness.command,
				args: [
					'-p',
					'--mode',
					'ask',
					'--trust',
					'--output-format',
					'stream-json',
					'--stream-partial-output',
					'--model',
					finalPayload.model ?? model.id,
					finalPayload.prompt ?? prompt
				],
				timeoutMs: cfg.timeoutMs,
				maxOutputChars: cfg.maxOutputChars,
				...(options?.signal ? { signal: options.signal } : {}),
				onLine: (line) => handleCursorLine(line, model, output, stream)
			})
			if (result.aborted) throw new Error('Request was aborted')
			if (result.timedOut) throw new Error(`cursor timed out after ${cfg.timeoutMs}ms`)
			if (result.code !== 0) {
				throw new Error(diagnostic(result.stderr) || `cursor exit ${result.code}`)
			}
			if (!output.content.some((block) => block.type === 'text')) appendText(output, stream, '')
			closeOpenBlocks(output, stream)
			if (output.stopReason === 'pending') output.stopReason = 'stop'
			if (output.stopReason === 'error' || output.stopReason === 'aborted') {
				stream.push({ type: 'error', reason: output.stopReason, error: output })
			} else {
				stream.push({ type: 'done', reason: doneReason(output.stopReason), message: output })
			}
			stream.end()
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
			output.errorMessage = redactError(error)
			stream.push({ type: 'error', reason: output.stopReason, error: output })
			stream.end()
		}
	})()
	return stream
}

export function streamAntigravityCli(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	readiness: Readiness,
	lineRunner: LineRunner = runStreamingLines
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream()
	const cfg = providerConfig(loadConfig(), 'antigravity')
	void (async () => {
		const output = createOutput(model)
		try {
			if (!readiness.ready || !readiness.command) {
				throw new Error(`antigravity provider_not_ready: ${readiness.reason}`)
			}
			const prompt = buildCliPrompt(context)
			const payload = { prompt, model: model.id, provider: 'antigravity', mode: 'compatibility' }
			const replacement = options?.onPayload ? await options.onPayload(payload, model) : payload
			const finalPayload =
				replacement && typeof replacement === 'object'
					? (replacement as { prompt?: string; model?: string })
					: payload
			await options?.onResponse?.({ status: 200, headers: {} }, model)
			stream.push({ type: 'start', partial: output })

			const promptArg = `-p=${finalPayload.prompt ?? prompt}`
			const result = await lineRunner({
				command: readiness.command,
				args: [
					'--output-format',
					'stream-json',
					'--model',
					finalPayload.model ?? model.id,
					'--mode',
					'plan',
					promptArg
				],
				timeoutMs: cfg.timeoutMs,
				maxOutputChars: cfg.maxOutputChars,
				...(options?.signal ? { signal: options.signal } : {}),
				onLine: (line) => handleAgyLine(line, model, output, stream)
			})
			if (result.aborted) throw new Error('Request was aborted')
			if (result.timedOut) throw new Error(`antigravity timed out after ${cfg.timeoutMs}ms`)
			if (result.code !== 0) {
				throw new Error(diagnostic(result.stderr) || `antigravity exit ${result.code}`)
			}
			closeOpenBlocks(output, stream)
			if (output.stopReason === 'pending') output.stopReason = 'stop'
			if (output.stopReason === 'error' || output.stopReason === 'aborted') {
				stream.push({ type: 'error', reason: output.stopReason, error: output })
			} else {
				stream.push({ type: 'done', reason: doneReason(output.stopReason), message: output })
			}
			stream.end()
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
			output.errorMessage = redactError(error)
			stream.push({ type: 'error', reason: output.stopReason, error: output })
			stream.end()
		}
	})()
	return stream
}
