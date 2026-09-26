let countFn: ((text: string) => number) | undefined

try {
	// Optional dynamic import / resolution for tokenizer
	const tokenizer = await import('@anthropic-ai/tokenizer').catch(() => null)
	if (tokenizer) {
		countFn = (tokenizer as any).countTokens ?? (tokenizer as any).default?.countTokens
	}
} catch {
	// Fallback to char heuristic
}

function charFallback(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Count tokens in a string using the Anthropic tokenizer,
 * falling back to the char-count heuristic on error.
 */
export function countTokens(text: string): number {
	if (!text) return 0
	try {
		if (countFn) return countFn(text)
	} catch {
		// fall through
	}
	return charFallback(text)
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
