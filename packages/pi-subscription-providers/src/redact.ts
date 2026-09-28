/** Redact secrets and PII from any string that may reach logs, errors, or tests. */

const SECRET_KEY =
	'access_token|refresh_token|id_token|accessToken|refreshToken|idToken|api_?key|apiKey|client_secret|password|secret'

const PATTERNS: [RegExp, string][] = [
	// JSON bodies: keep the key, drop the value.
	[new RegExp(`"(${SECRET_KEY})"\\s*:\\s*"[^"]*"`, 'gi'), '"$1": "[REDACTED]"'],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED]'],
	[/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]'],
	[
		/\b(Authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|CURSOR_API_KEY|JEV_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*\S+/gi,
		'[REDACTED]'
	],
	// JWTs, Google OAuth access (ya29.) and refresh (1//) tokens.
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED]'],
	[/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED]'],
	[/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED]'],
	[/\b[a-f0-9]{40,}\b/gi, '[REDACTED]']
]

export function redact(text: string): string {
	let out = text
	for (const [pattern, replacement] of PATTERNS) {
		out = out.replace(pattern, replacement)
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
