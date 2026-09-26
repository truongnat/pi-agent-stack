import { countTokens as nativeCountTokens } from 'pi-native-bridge'

function charFallback(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Count tokens in a string using native Rust BPE tokenizer,
 * falling back to the char-count heuristic on error.
 */
export function countTokens(text: string, modelFamily = 'generic'): number {
	if (!text) return 0
	try {
		return nativeCountTokens(text, modelFamily)
	} catch {
		return charFallback(text)
	}
}

/**
 * Estimate tokens for a batch of texts. Joining is close enough for
 * budgeting and avoids N separate tokenizer calls.
 */
export function estimateTokensBatch(texts: string[]): number {
	if (texts.length === 0) return 0
	return countTokens(texts.join(' '))
}

/** Alias used by messages.ts and strategies. */
export function approxTokens(text: string): number {
	return countTokens(text)
}
