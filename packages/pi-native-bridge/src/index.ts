import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

export interface NativeBridge {
	isAvailable: boolean
	version: string
	countTokens: (text: string, modelFamily?: string) => number
	countTokensBPE: (text: string, encoding?: string) => number
	hashToolSignature: (toolName: string, canonicalArgs: string) => string
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
	_maxOutputBytes = 10485760
): ProcessExecutionResult {
	const startTime = Date.now()
	try {
		const res = spawnSync(cmd, {
			shell: true,
			cwd: cwd || undefined,
			timeout: timeoutMs,
			encoding: 'utf8',
			maxBuffer: 10 * 1024 * 1024
		})
		const timed_out = res.error?.message?.includes('ETIMEDOUT') || res.status === null
		return {
			exit_code: res.status ?? (timed_out ? -9 : -1),
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
let nativeVersion = '0.4.0-ts-fallback'

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
	scanDirectory,
	searchWorkspace,
	skeletonizeCode,
	spawnSupervised,
	killProcessGroup,
	isProcessAlive
}

export default bridge
