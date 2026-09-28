import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { constants as osConstants } from 'node:os'

export interface FileEntry {
	path: string
	is_dir: boolean
	size: number
}

export interface SearchMatch {
	path: string
	line_number: number
	line_text: string
}

export interface SkeletonResult {
	language: string
	skeleton: string
	original_bytes: number
	skeleton_bytes: number
	reduction_percentage: number
}

export interface ProcessExecutionResult {
	exit_code: number
	stdout: string
	stderr: string
	timed_out: boolean
	duration_ms: number
}

export interface DocumentItem {
	id: string
	text: string
	tags?: string[]
	utility?: number
}

export interface RankedDocument {
	id: string
	score: number
	text: string
}

export interface NativeBridge {
	isAvailable: boolean
	version: string
	countTokens: (text: string, modelFamily?: string) => number
	countTokensBPE: (text: string, encoding?: string) => number
	hashToolSignature: (toolName: string, canonicalArgs: string) => string
	fingerprintPrompt: (text: string) => string
	scanDirectory: (dirPath: string, maxDepth?: number) => FileEntry[]
	searchWorkspace: (dirPath: string, query: string, maxResults?: number) => SearchMatch[]
	skeletonizeCode: (source: string, language?: string) => SkeletonResult
	spawnSupervised: (
		cmd: string,
		cwd?: string,
		timeoutMs?: number,
		maxOutputBytes?: number
	) => ProcessExecutionResult
	killProcessGroup: (pgid: number, signal?: number) => number
	isProcessAlive: (pid: number) => boolean
	vectorCosineSimilarity: (a: Float32Array | number[], b: Float32Array | number[]) => number
	trigramSimilarity: (a: string, b: string) => number
	rankDocuments: (query: string, documents: DocumentItem[], topK?: number) => RankedDocument[]
}

// Fallback implementations in pure TypeScript
function fallbackCountTokens(text: string): number {
	if (!text) return 0
	return Math.max(1, Math.ceil(text.length / 4))
}

function fallbackHashToolSignature(toolName: string, canonicalArgs: string): string {
	let hash = 0n
	const combined = `${toolName}\0${canonicalArgs}`
	for (let i = 0; i < combined.length; i++) {
		hash = (hash * 31n + BigInt(combined.charCodeAt(i))) & 0xffffffffffffffffn
	}
	return hash.toString(16)
}

function fallbackScanDirectory(): FileEntry[] {
	return []
}

/** No TS search engine: callers check isNativeAvailable() and use `rg` themselves. */
function fallbackSearchWorkspace(): SearchMatch[] {
	return []
}

function fallbackSkeletonizeCode(source: string, language = 'ts'): SkeletonResult {
	const lines = source.split('\n')
	const kept: string[] = []
	for (const line of lines) {
		const trimmed = line.trim()
		if (
			trimmed.startsWith('import ') ||
			trimmed.startsWith('export ') ||
			trimmed.startsWith('use ') ||
			trimmed.startsWith('def ') ||
			trimmed.startsWith('class ') ||
			trimmed.startsWith('interface ') ||
			trimmed.startsWith('type ')
		) {
			kept.push(line)
		}
	}
	const skeleton = kept.join('\n')
	const original_bytes = source.length
	const skeleton_bytes = skeleton.length
	const reduction_percentage =
		original_bytes > 0 && original_bytes >= skeleton_bytes
			? Math.round(((original_bytes - skeleton_bytes) / original_bytes) * 1000) / 10
			: 0

	return {
		language,
		skeleton,
		original_bytes,
		skeleton_bytes,
		reduction_percentage
	}
}

function fallbackSpawnSupervised(
	cmd: string,
	cwd = '',
	timeoutMs = 60000,
	maxOutputBytes = 10485760
): ProcessExecutionResult {
	const startTime = Date.now()
	try {
		const res = spawnSync(cmd, {
			shell: true,
			cwd: cwd || undefined,
			timeout: timeoutMs,
			encoding: 'utf8',
			maxBuffer: maxOutputBytes
		})
		// Only a real timeout counts as one; a signal death (OOM kill, SIGSEGV) is a failure
		// with exit code 128 + signal, like a shell reports it.
		const timed_out = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
		const signalCode = res.signal ? (osConstants.signals[res.signal] ?? 0) : 0
		return {
			exit_code: res.status ?? (timed_out ? -9 : signalCode ? 128 + signalCode : -1),
			stdout: res.stdout || '',
			stderr: res.stderr || (res.error ? res.error.message : ''),
			timed_out,
			duration_ms: Date.now() - startTime
		}
	} catch (err: any) {
		return {
			exit_code: -1,
			stdout: '',
			stderr: err?.message || String(err),
			timed_out: false,
			duration_ms: Date.now() - startTime
		}
	}
}

function fallbackKillProcessGroup(pgid: number, signal = 9): number {
	try {
		process.kill(-pgid, signal)
		return 0
	} catch {
		return -1
	}
}

function fallbackIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function fallbackVectorCosineSimilarity(
	a: Float32Array | number[],
	b: Float32Array | number[]
): number {
	if (!a.length || a.length !== b.length) return 0
	let dot = 0
	let normA = 0
	let normB = 0
	for (let i = 0; i < a.length; i++) {
		const va = a[i]!
		const vb = b[i]!
		dot += va * vb
		normA += va * va
		normB += vb * vb
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB)
	return denom < 1e-9 ? 0 : dot / denom
}

function fallbackTrigramSimilarity(a: string, b: string): number {
	if (a === b) return 1
	if (!a || !b) return 0
	const getTrigrams = (str: string) => {
		const lower = str.toLowerCase()
		const set = new Set<string>()
		for (let i = 0; i < lower.length - 2; i++) {
			set.add(lower.slice(i, i + 3))
		}
		return set
	}
	const triA = getTrigrams(a)
	const triB = getTrigrams(b)
	if (triA.size === 0 || triB.size === 0) return 0
	let inter = 0
	for (const t of triA) {
		if (triB.has(t)) inter++
	}
	return (2 * inter) / (triA.size + triB.size)
}

function fallbackRankDocuments(
	query: string,
	documents: DocumentItem[],
	topK = 5
): RankedDocument[] {
	const scored = documents.map((doc) => {
		const sim = fallbackTrigramSimilarity(query, doc.text)
		const containsWord = query
			.toLowerCase()
			.split(' ')
			.some((w) => w.length > 2 && doc.text.toLowerCase().includes(w))
			? 0.3
			: 0
		return {
			id: doc.id,
			score: sim * 0.7 + containsWord + (doc.utility || 0) * 0.05,
			text: doc.text
		}
	})
	scored.sort((a, b) => b.score - a.score)
	return scored.slice(0, topK)
}

/** The pi-core Node-API addon (crates/pi-core-napi). Loads in Node (Pi) and Bun alike. */
interface Addon {
	version(): string
	countTokens(text: string, modelFamily: string): number
	countTokensBpe(text: string, encoding: string): number
	hashToolSignature(toolName: string, canonicalArgs: string): string
	hashPrompt(text: string): string
	scanDirectory(dirPath: string, maxDepth: number): FileEntry[]
	searchWorkspace(dirPath: string, query: string, maxResults: number): SearchMatch[]
	skeletonizeCode(source: string, language: string): SkeletonResult
	spawnSupervised(
		cmd: string,
		cwd: string,
		timeoutMs: number,
		maxOutputBytes: number
	): ProcessExecutionResult
	cosineSimilarity(a: number[], b: number[]): number
	trigramSimilarity(a: string, b: string): number
	rankDocuments(query: string, documents: DocumentItem[], topK: number): RankedDocument[]
	killProcessGroup(pgid: number, signal: number): number
	isProcessAlive(pid: number): boolean
}

/**
 * `native/pi_core.node` is where install.sh puts the built addon; the cargo outputs cover
 * development in the repo (crates/target, or CARGO_TARGET_DIR when set).
 */
function addonCandidates(): string[] {
	const here = dirname(fileURLToPath(import.meta.url))
	const repo = join(here, '..', '..', '..')
	const targets = [
		join(repo, 'crates', 'target'),
		...(process.env.CARGO_TARGET_DIR ? [process.env.CARGO_TARGET_DIR] : [])
	]
	const names = ['libpi_core_napi.so', 'libpi_core_napi.dylib', 'pi_core_napi.dll']
	return [
		join(here, '..', 'native', 'pi_core.node'),
		...targets.flatMap((t) =>
			['release', 'debug'].flatMap((profile) => names.map((n) => join(t, profile, n)))
		)
	]
}

function loadAddon(): Addon | null {
	for (const path of addonCandidates()) {
		if (!existsSync(path)) continue
		try {
			const mod = { exports: {} as Addon }
			process.dlopen(mod, path)
			return mod.exports
		} catch {
			// Wrong platform or stale build: try the next one, then the TS fallbacks.
		}
	}
	return null
}

const addon = loadAddon()
const isNative = addon !== null
const nativeVersion = addon ? addon.version() : '0.5.0-ts-fallback'

/** Native when the addon loaded, else (or if it throws) the TypeScript fallback. */
function call<T>(native: (a: Addon) => T, fallback: () => T): T {
	if (!addon) return fallback()
	try {
		return native(addon)
	} catch {
		return fallback()
	}
}

export function isNativeAvailable(): boolean {
	return isNative
}

export function getNativeVersion(): string {
	return nativeVersion
}

export function countTokens(text: string, modelFamily = 'generic'): number {
	return call(
		(a) => a.countTokens(text, modelFamily),
		() => fallbackCountTokens(text)
	)
}

export function countTokensBPE(text: string, encoding = 'cl100k_base'): number {
	return call(
		(a) => a.countTokensBpe(text, encoding),
		() => fallbackCountTokens(text)
	)
}

export function hashToolSignature(toolName: string, canonicalArgs: string): string {
	return call(
		(a) => a.hashToolSignature(toolName, canonicalArgs),
		() => fallbackHashToolSignature(toolName, canonicalArgs)
	)
}

export function fingerprintPrompt(text: string): string {
	if (!text) return '0'
	return call(
		(a) => a.hashPrompt(text),
		() => fallbackHashToolSignature('prompt', text)
	)
}

export function scanDirectory(dirPath: string, maxDepth = 6): FileEntry[] {
	return call((a) => a.scanDirectory(dirPath, maxDepth), fallbackScanDirectory)
}

export function searchWorkspace(dirPath: string, query: string, maxResults = 50): SearchMatch[] {
	return call((a) => a.searchWorkspace(dirPath, query, maxResults), fallbackSearchWorkspace)
}

export function skeletonizeCode(source: string, language = 'ts'): SkeletonResult {
	return call(
		(a) => a.skeletonizeCode(source, language),
		() => fallbackSkeletonizeCode(source, language)
	)
}

export function spawnSupervised(
	cmd: string,
	cwd = '',
	timeoutMs = 180000,
	maxOutputBytes = 10485760
): ProcessExecutionResult {
	return call(
		(a) => a.spawnSupervised(cmd, cwd, timeoutMs, maxOutputBytes),
		() => fallbackSpawnSupervised(cmd, cwd, timeoutMs, maxOutputBytes)
	)
}

export function vectorCosineSimilarity(
	a: Float32Array | number[],
	b: Float32Array | number[]
): number {
	return call(
		(n) => n.cosineSimilarity(Array.from(a), Array.from(b)),
		() => fallbackVectorCosineSimilarity(a, b)
	)
}

export function trigramSimilarity(a: string, b: string): number {
	return call(
		(n) => n.trigramSimilarity(a, b),
		() => fallbackTrigramSimilarity(a, b)
	)
}

export function rankDocuments(
	query: string,
	documents: DocumentItem[],
	topK = 5
): RankedDocument[] {
	return call(
		(a) => a.rankDocuments(query, documents, topK),
		() => fallbackRankDocuments(query, documents, topK)
	)
}

export function killProcessGroup(pgid: number, signal = 9): number {
	return call(
		(a) => a.killProcessGroup(pgid, signal),
		() => fallbackKillProcessGroup(pgid, signal)
	)
}

export function isProcessAlive(pid: number): boolean {
	return call(
		(a) => a.isProcessAlive(pid),
		() => fallbackIsProcessAlive(pid)
	)
}

export const bridge: NativeBridge = {
	isAvailable: isNative,
	version: nativeVersion,
	countTokens,
	countTokensBPE,
	hashToolSignature,
	fingerprintPrompt,
	scanDirectory,
	searchWorkspace,
	skeletonizeCode,
	spawnSupervised,
	killProcessGroup,
	isProcessAlive,
	vectorCosineSimilarity,
	trigramSimilarity,
	rankDocuments
}

export default bridge
