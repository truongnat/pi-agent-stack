/** Redact secrets and PII from any string that may reach logs, errors, or tests. */

const PATTERNS: RegExp[] = [
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
	/\bsk-[A-Za-z0-9_-]{8,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(Authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|CURSOR_API_KEY|JEV_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*\S+/gi,
	/\b[a-f0-9]{40,}\b/gi
]

export function redact(text: string): string {
	let out = text
	for (const pattern of PATTERNS) {
		out = out.replace(pattern, '[REDACTED]')
	}
	return out
}

export function redactError(error: unknown): string {
	if (error instanceof Error) return redact(error.message)
	return redact(String(error))
}

/** Compact diagnostic: first line, redacted, length-capped. */
export function diagnostic(text: string, max = 160): string {
	const line =
		redact(text)
			.split(/\r?\n/)
			.find((part) => part.trim()) ?? ''
	const trimmed = line.trim()
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}
