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

// Locate native library
function findNativeLibrary(): string | null {
	const currentDir = dirname(fileURLToPath(import.meta.url))
	const candidatePaths = [
		// In-repo development build
		join(
			currentDir,
			'..',
			'..',
			'..',
			'crates',
			'pi-core',
			'target',
			'release',
			'libpi_core.dylib'
		),
		join(currentDir, '..', '..', '..', 'crates', 'pi-core', 'target', 'debug', 'libpi_core.dylib'),
		join(currentDir, '..', '..', '..', 'crates', 'pi-core', 'target', 'release', 'libpi_core.so'),
		join(currentDir, '..', '..', '..', 'crates', 'pi-core', 'target', 'debug', 'libpi_core.so'),
		join(currentDir, '..', '..', '..', 'crates', 'pi-core', 'target', 'release', 'pi_core.dll'),
		// Installed runtime path
		join(
			process.env.HOME || '',
			'.pi',
			'agent',
			'pi-agent-stack',
			'crates',
			'pi-core',
			'target',
			'release',
			'libpi_core.dylib'
		)
	]

	for (const p of candidatePaths) {
		if (existsSync(p)) return p
	}
	return null
}

let nativeLib: any = null
let isNative = false
let nativeVersion = '0.5.0-ts-fallback'

try {
	const libPath = findNativeLibrary()
	if (libPath && typeof (globalThis as any).Bun !== 'undefined') {
		const { dlopen, CString } = (globalThis as any).Bun.FFI
		nativeLib = dlopen(libPath, {
			pi_core_version: {
				args: [],
				returns: 'ptr'
			},
			pi_count_tokens: {
				args: ['ptr', 'ptr'],
				returns: 'u32'
			},
			pi_count_tokens_bpe: {
				args: ['ptr', 'ptr'],
				returns: 'u32'
			},
			pi_hash_tool_signature: {
				args: ['ptr', 'ptr'],
				returns: 'u64'
			},
			pi_hash_prompt: {
				args: ['ptr'],
				returns: 'u64'
			},
			pi_scan_directory: {
				args: ['ptr', 'u32'],
				returns: 'ptr'
			},
			pi_search_workspace: {
				args: ['ptr', 'ptr', 'u32'],
				returns: 'ptr'
			},
			pi_skeletonize_code: {
				args: ['ptr', 'ptr'],
				returns: 'ptr'
			},
			pi_spawn_supervised: {
				args: ['ptr', 'ptr', 'u64', 'usize'],
				returns: 'ptr'
			},
			pi_vector_cosine_similarity: {
				args: ['ptr', 'ptr', 'usize'],
				returns: 'f32'
			},
			pi_trigram_similarity: {
				args: ['ptr', 'ptr'],
				returns: 'f32'
			},
			pi_rank_documents: {
				args: ['ptr', 'ptr', 'usize'],
				returns: 'ptr'
			},
			pi_kill_process_group: {
				args: ['i32', 'i32'],
				returns: 'i32'
			},
			pi_is_process_alive: {
				args: ['i32'],
				returns: 'bool'
			},
			pi_free_string: {
				args: ['ptr'],
				returns: 'void'
			}
		})

		const verPtr = nativeLib.symbols.pi_core_version()
		if (verPtr) {
			nativeVersion = new CString(verPtr).toString()
			nativeLib.symbols.pi_free_string(verPtr)
			isNative = true
		}
	}
} catch {
	isNative = false
}

export function isNativeAvailable(): boolean {
	return isNative
}

export function getNativeVersion(): string {
	return nativeVersion
}

export function countTokens(text: string, modelFamily = 'generic'): number {
	if (!isNative || !nativeLib) {
		return fallbackCountTokens(text)
	}

	try {
		const textBuf = Buffer.from(`${text}\0`, 'utf8')
		const familyBuf = Buffer.from(`${modelFamily}\0`, 'utf8')
		const { ptr } = (globalThis as any).Bun.FFI
		return nativeLib.symbols.pi_count_tokens(ptr(textBuf), ptr(familyBuf))
	} catch {
		return fallbackCountTokens(text)
	}
}

export function countTokensBPE(text: string, encoding = 'cl100k_base'): number {
	if (!isNative || !nativeLib) {
		return fallbackCountTokens(text)
	}

	try {
		const textBuf = Buffer.from(`${text}\0`, 'utf8')
		const encBuf = Buffer.from(`${encoding}\0`, 'utf8')
		const { ptr } = (globalThis as any).Bun.FFI
		return nativeLib.symbols.pi_count_tokens_bpe(ptr(textBuf), ptr(encBuf))
	} catch {
		return fallbackCountTokens(text)
	}
}

export function hashToolSignature(toolName: string, canonicalArgs: string): string {
	if (!isNative || !nativeLib) {
		return fallbackHashToolSignature(toolName, canonicalArgs)
	}

	try {
		const nameBuf = Buffer.from(`${toolName}\0`, 'utf8')
		const argsBuf = Buffer.from(`${canonicalArgs}\0`, 'utf8')
		const { ptr } = (globalThis as any).Bun.FFI
		const hashVal: bigint = nativeLib.symbols.pi_hash_tool_signature(ptr(nameBuf), ptr(argsBuf))
		return hashVal.toString(16)
	} catch {
		return fallbackHashToolSignature(toolName, canonicalArgs)
	}
}

export function fingerprintPrompt(text: string): string {
	if (!text) return '0'
	if (!isNative || !nativeLib) {
		return fallbackHashToolSignature('prompt', text)
	}
	try {
		const buf = Buffer.from(`${text}\0`, 'utf8')
		const { ptr } = (globalThis as any).Bun.FFI
		const hashVal: bigint = nativeLib.symbols.pi_hash_prompt(ptr(buf))
		return hashVal.toString(16)
	} catch {
		return fallbackHashToolSignature('prompt', text)
	}
}

export function scanDirectory(dirPath: string, maxDepth = 6): FileEntry[] {
	if (!isNative || !nativeLib) {
		return fallbackScanDirectory()
	}

	try {
		const pathBuf = Buffer.from(`${dirPath}\0`, 'utf8')
		const { ptr, CString } = (globalThis as any).Bun.FFI
		const resPtr = nativeLib.symbols.pi_scan_directory(ptr(pathBuf), maxDepth)
		if (!resPtr) return []
		const jsonStr = new CString(resPtr).toString()
		nativeLib.symbols.pi_free_string(resPtr)
		return JSON.parse(jsonStr)
	} catch {
		return fallbackScanDirectory()
	}
}

export function searchWorkspace(dirPath: string, query: string, maxResults = 50): SearchMatch[] {
	if (!isNative || !nativeLib) {
		return fallbackSearchWorkspace()
	}

	try {
		const pathBuf = Buffer.from(`${dirPath}\0`, 'utf8')
		const queryBuf = Buffer.from(`${query}\0`, 'utf8')
		const { ptr, CString } = (globalThis as any).Bun.FFI
		const resPtr = nativeLib.symbols.pi_search_workspace(ptr(pathBuf), ptr(queryBuf), maxResults)
		if (!resPtr) return []
		const jsonStr = new CString(resPtr).toString()
		nativeLib.symbols.pi_free_string(resPtr)
		return JSON.parse(jsonStr)
	} catch {
		return fallbackSearchWorkspace()
	}
}

export function skeletonizeCode(source: string, language = 'ts'): SkeletonResult {
	if (!isNative || !nativeLib) {
		return fallbackSkeletonizeCode(source, language)
	}

	try {
		const srcBuf = Buffer.from(`${source}\0`, 'utf8')
		const langBuf = Buffer.from(`${language}\0`, 'utf8')
		const { ptr, CString } = (globalThis as any).Bun.FFI
		const resPtr = nativeLib.symbols.pi_skeletonize_code(ptr(srcBuf), ptr(langBuf))
		if (!resPtr) return fallbackSkeletonizeCode(source, language)
		const jsonStr = new CString(resPtr).toString()
		nativeLib.symbols.pi_free_string(resPtr)
		return JSON.parse(jsonStr)
	} catch {
		return fallbackSkeletonizeCode(source, language)
	}
}

export function spawnSupervised(
	cmd: string,
	cwd = '',
	timeoutMs = 180000,
	maxOutputBytes = 10485760
): ProcessExecutionResult {
	if (!isNative || !nativeLib) {
		return fallbackSpawnSupervised(cmd, cwd, timeoutMs, maxOutputBytes)
	}

	try {
		const cmdBuf = Buffer.from(`${cmd}\0`, 'utf8')
		const cwdBuf = Buffer.from(`${cwd}\0`, 'utf8')
		const { ptr, CString } = (globalThis as any).Bun.FFI
		const resPtr = nativeLib.symbols.pi_spawn_supervised(
			ptr(cmdBuf),
			ptr(cwdBuf),
			BigInt(timeoutMs),
			maxOutputBytes
		)
		if (!resPtr) return fallbackSpawnSupervised(cmd, cwd, timeoutMs, maxOutputBytes)
		const jsonStr = new CString(resPtr).toString()
		nativeLib.symbols.pi_free_string(resPtr)
		return JSON.parse(jsonStr)
	} catch {
		return fallbackSpawnSupervised(cmd, cwd, timeoutMs, maxOutputBytes)
	}
}

export function vectorCosineSimilarity(
	a: Float32Array | number[],
	b: Float32Array | number[]
): number {
	if (!isNative || !nativeLib) {
		return fallbackVectorCosineSimilarity(a, b)
	}

	try {
		// Rust reads `len` floats from both pointers: mismatched lengths would read past `b`.
		if (!a.length || a.length !== b.length) return 0
		const bufA = a instanceof Float32Array ? a : new Float32Array(a)
		const bufB = b instanceof Float32Array ? b : new Float32Array(b)
		const { ptr } = (globalThis as any).Bun.FFI
		return nativeLib.symbols.pi_vector_cosine_similarity(ptr(bufA), ptr(bufB), bufA.length)
	} catch {
		return fallbackVectorCosineSimilarity(a, b)
	}
}

export function trigramSimilarity(a: string, b: string): number {
	if (!isNative || !nativeLib) {
		return fallbackTrigramSimilarity(a, b)
	}

	try {
		const aBuf = Buffer.from(`${a}\0`, 'utf8')
		const bBuf = Buffer.from(`${b}\0`, 'utf8')
		const { ptr } = (globalThis as any).Bun.FFI
		return nativeLib.symbols.pi_trigram_similarity(ptr(aBuf), ptr(bBuf))
	} catch {
		return fallbackTrigramSimilarity(a, b)
	}
}

export function rankDocuments(
	query: string,
	documents: DocumentItem[],
	topK = 5
): RankedDocument[] {
	if (!isNative || !nativeLib) {
		return fallbackRankDocuments(query, documents, topK)
	}

	try {
		const qBuf = Buffer.from(`${query}\0`, 'utf8')
		const docsBuf = Buffer.from(`${JSON.stringify(documents)}\0`, 'utf8')
		const { ptr, CString } = (globalThis as any).Bun.FFI
		const resPtr = nativeLib.symbols.pi_rank_documents(ptr(qBuf), ptr(docsBuf), topK)
		if (!resPtr) return fallbackRankDocuments(query, documents, topK)
		const jsonStr = new CString(resPtr).toString()
		nativeLib.symbols.pi_free_string(resPtr)
		return JSON.parse(jsonStr)
	} catch {
		return fallbackRankDocuments(query, documents, topK)
	}
}

export function killProcessGroup(pgid: number, signal = 9): number {
	if (!isNative || !nativeLib) {
		return fallbackKillProcessGroup(pgid, signal)
	}

	try {
		return nativeLib.symbols.pi_kill_process_group(pgid, signal)
	} catch {
		return fallbackKillProcessGroup(pgid, signal)
	}
}

export function isProcessAlive(pid: number): boolean {
	if (!isNative || !nativeLib) {
		return fallbackIsProcessAlive(pid)
	}

	try {
		return nativeLib.symbols.pi_is_process_alive(pid)
	} catch {
		return fallbackIsProcessAlive(pid)
	}
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
