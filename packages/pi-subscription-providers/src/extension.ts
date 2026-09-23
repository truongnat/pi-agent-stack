/**
 * Pi extension: register Cursor and Antigravity subscription providers.
 *
 * Authentication is delegated to the official CLIs. This extension never reads
 * cookies, auth.json, or OAuth token files. Models appear only when readiness
 * is confirmed. Both providers run in documented compatibility mode: assistant
 * text/thinking/usage stream through Pi; native Pi tool-call wire is not claimed.
 *
 * Startup is cache-first and non-blocking so missing CLIs never stall Pi.
 * Background readiness refresh re-publishes provider model lists into the live registry.
 *
 * Important: Pi calls refreshModels after every registerProvider with
 * allowNetwork=false. That path must return the in-memory snapshot only — never
 * probe CLIs or call publishProviders again (that caused a refresh cascade).
 */
import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import { loadConfig } from './config.ts'
import { toProviderModels } from './models.ts'
import { compactSummaries, readStatus, refreshStatus, writeStatus } from './readiness.ts'
import { streamAntigravityCli, streamCursorCli } from './stream.ts'
import type { ProviderId, Readiness, RootConfig, StatusSnapshot } from './types.ts'

const CURSOR_API = 'cursor-cli-compat'
const ANTIGRAVITY_API = 'antigravity-cli-compat'

let snapshot: StatusSnapshot | null = null

function unavailable(provider: ProviderId, reason: string): Readiness {
	return {
		provider,
		ready: false,
		reason,
		billingMode: 'subscription',
		latencyEstimateMs: 0,
		marginalInputCost: 0.15,
		marginalOutputCost: 0.6,
		models: [],
		checkedAt: 0,
		toolMode: 'compatibility'
	}
}

function readinessOrUnavailable(provider: ProviderId, current: StatusSnapshot | null): Readiness {
	return current?.[provider] ?? unavailable(provider, 'provider_not_ready')
}

function initialSnapshot(): StatusSnapshot {
	const cached = readStatus()
	if (cached) return cached
	return {
		updatedAt: Date.now(),
		cursor: unavailable('cursor', 'pending readiness check'),
		antigravity: unavailable('antigravity', 'pending readiness check')
	}
}

/** Snapshot-only catalog used by offline Pi refreshes after registerProvider. */
export function modelsFromSnapshot(
	provider: ProviderId,
	snap: StatusSnapshot | null
): ProviderModelConfig[] {
	return toProviderModels(provider, readinessOrUnavailable(provider, snap))
}

/**
 * refreshModels contract:
 * - allowNetwork=false (Pi post-register refresh): return current snapshot, no CLI.
 * - allowNetwork=true: probe (TTL unless force), update snapshot, return models.
 * Never calls publishProviders — returning the list is how Pi updates the catalog.
 */
export async function refreshProviderModels(
	provider: ProviderId,
	context: { allowNetwork?: boolean; force?: boolean; signal?: AbortSignal },
	config: RootConfig = loadConfig()
): Promise<ProviderModelConfig[]> {
	if (context.signal?.aborted) throw new Error('aborted')
	if (!context.allowNetwork) {
		return modelsFromSnapshot(provider, snapshot)
	}
	snapshot = await refreshStatus(config, undefined, {
		force: context.force === true
	})
	if (context.signal?.aborted) throw new Error('aborted')
	writeStatus(snapshot)
	return modelsFromSnapshot(provider, snapshot)
}

function publishProviders(pi: ExtensionAPI, snap: StatusSnapshot): void {
	snapshot = snap
	pi.registerProvider('cursor', {
		name: 'Cursor (CLI subscription)',
		baseUrl: 'cli://cursor-agent',
		apiKey: 'subscription-cli',
		api: CURSOR_API,
		models: modelsFromSnapshot('cursor', snap),
		refreshModels: (context) => refreshProviderModels('cursor', context),
		streamSimple: (model, context, options) =>
			streamCursorCli(model, context, options, readinessOrUnavailable('cursor', snapshot))
	})

	pi.registerProvider('antigravity', {
		name: 'Google Antigravity (CLI subscription)',
		baseUrl: 'cli://agy',
		apiKey: 'subscription-cli',
		api: ANTIGRAVITY_API,
		models: modelsFromSnapshot('antigravity', snap),
		refreshModels: (context) => refreshProviderModels('antigravity', context),
		streamSimple: (model, context, options) =>
			streamAntigravityCli(model, context, options, readinessOrUnavailable('antigravity', snapshot))
	})
}

function applyStatusUi(
	ctx: { hasUI: boolean; ui: { setStatus: (id: string, text: string) => void } },
	snap: StatusSnapshot
): void {
	if (!ctx.hasUI) return
	const summaries = compactSummaries(snap)
	const parts = [summaries.cursor, summaries.antigravity].filter(
		(line) => !line.includes('disabled')
	)
	ctx.ui.setStatus('subscription-providers', parts.map((line) => line.split(';')[0]).join(' · '))
}

export default function (pi: ExtensionAPI): void {
	const config: RootConfig = loadConfig()
	snapshot = initialSnapshot()
	publishProviders(pi, snapshot)

	pi.on('session_start', (_event, ctx) => {
		// Probe once in the background, then publish that snapshot.
		// registerProvider triggers an offline refreshModels pass that must not re-probe.
		void refreshStatus(config)
			.then((next) => {
				writeStatus(next)
				publishProviders(pi, next)
				applyStatusUi(ctx, next)
			})
			.catch(() => {
				// Readiness refresh must never break session start.
			})
	})

	pi.registerCommand('subscription-providers', {
		description: 'subscription-providers: status | refresh',
		handler: async (args, ctx) => {
			const cmd = (args ?? '').trim()
			if (cmd === 'refresh') {
				snapshot = await refreshStatus(config, undefined, { force: true })
			} else {
				snapshot = snapshot ?? (await refreshStatus(config))
			}
			writeStatus(snapshot)
			publishProviders(pi, snapshot)
			const summaries = compactSummaries(snapshot)
			ctx.ui.notify(`${summaries.cursor}\n${summaries.antigravity}`, 'info')
		}
	})
}