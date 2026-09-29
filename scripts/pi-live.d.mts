import { spawn } from 'node:child_process'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export const DEFAULT_PORT: number
export const DEFAULT_FALLBACK_PORT: number
export function dashboardUrl(port?: number): string
export function fallbackUrl(port?: number): string
export function portOpen(port: number, host?: string, timeoutMs?: number): Promise<boolean>
export function offlineHtml(live: string): string
export function openBrowser(
	url: string,
	platform?: NodeJS.Platform,
	spawnFn?: typeof spawn
): void
export function serveOffline(
	live: string,
	fallbackPort: number
): Promise<Server<typeof IncomingMessage, typeof ServerResponse>>
export function fallbackTabIsWatchingFromStatus(
	data: { viewers?: number; handoffUntil?: number } | null | undefined,
	now?: number
): boolean
export function resolveDashboardTarget(opts?: {
	livePort?: number
	fallbackPort?: number
	probe?: (port: number) => Promise<boolean>
}): Promise<
	| { url: string; mode: 'live' }
	| {
			url: string
			mode: 'offline'
			livePort: number
			fallbackPort: number
			live: string
	  }
>
