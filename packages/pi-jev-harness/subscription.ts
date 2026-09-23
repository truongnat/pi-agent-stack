/**
 * Compact subscription-provider status for JEV routing.
 * Reads the cache written by pi-subscription-providers; never probes CLIs here
 * and never logs secrets or raw CLI output.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BillingMode = 'api' | 'subscription' | 'unknown'

export type SubscriptionReadiness = {
	provider: 'cursor' | 'antigravity'
	ready: boolean
	reason: string
	billingMode: BillingMode
	quotaAvailable?: boolean | undefined
	latencyEstimateMs: number
	marginalInputCost: number
	marginalOutputCost: number
	models: { id: string; name: string; reasoning: boolean }[]
	checkedAt: number
	toolMode: 'compatibility'
}

export type SubscriptionStatus = {
	updatedAt: number
	cursor: SubscriptionReadiness
	antigravity: SubscriptionReadiness
}

const STATUS_PATH = join(homedir(), '.pi', 'agent', 'subscription-providers-status.json')

const DEFAULT_TTL_MS = 5 * 60_000

export function readSubscriptionStatus(path = STATUS_PATH): SubscriptionStatus | null {
	try {
		// SAFETY: local cache from pi-subscription-providers; malformed → ignore.
		return JSON.parse(readFileSync(path, 'utf8')) as SubscriptionStatus
	} catch {
		return null
	}
}

export function freshSubscriptionProviders(
	status: SubscriptionStatus | null,
	now = Date.now(),
	ttlMs = DEFAULT_TTL_MS
): SubscriptionReadiness[] {
	if (!status) return []
	return [status.cursor, status.antigravity].filter(
		(row) => row.ready && row.quotaAvailable !== false && now - row.checkedAt <= ttlMs
	)
}

/** Compatibility providers may only serve answer turns (no native Pi tool-call wire). */
export function subscriptionAllowedForKind(kind: string): boolean {
	return kind === 'answer'
}

/** Current Cursor/Antigravity session must leave subscription when the turn needs native tools. */
export function needsForcedSubscriptionExit(kind: string, provider: string): boolean {
	return (provider === 'cursor' || provider === 'antigravity') && !subscriptionAllowedForKind(kind)
}

export function redactSubscriptionLog(entry: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(entry)) {
		if (/token|secret|password|authorization|email|cookie|apiKey/i.test(key)) continue
		if (typeof value === 'string') {
			out[key] = value
				.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED]')
				.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
				.replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
			continue
		}
		out[key] = value
	}
	return out
}
