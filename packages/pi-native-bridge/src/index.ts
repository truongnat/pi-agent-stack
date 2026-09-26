import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FileEntry {
	path: string
	is_dir: boolean
	size: number
}

export interface NativeBridge {
	isAvailable: boolean
	version: string
	countTokens: (text: string, modelFamily?: string) => number
	hashToolSignature: (toolName: string, canonicalArgs: string) => string
	scanDirectory: (dirPath: string, maxDepth?: number) => FileEntry[]
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
let nativeVersion = '0.1.0-ts-fallback'

try {
	const libPath = findNativeLibrary()
	if (libPath && typeof (globalThis as any).Bun !== 'undefined') {
		const { dlopen, FFIType, ptr, CString } = (globalThis as any).Bun.FFI
		nativeLib = dlopen(libPath, {
			pi_core_version: {
				args: [],
				returns: FFIType.ptr
			},
			pi_count_tokens: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.u32
			},
			pi_hash_tool_signature: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.u64
			},
			pi_scan_directory: {
				args: [FFIType.ptr, FFIType.u32],
				returns: FFIType.ptr
			},
			pi_free_string: {
				args: [FFIType.ptr],
				returns: FFIType.void
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

export const bridge: NativeBridge = {
	isAvailable: isNative,
	version: nativeVersion,
	countTokens,
	hashToolSignature,
	scanDirectory
}

export default bridge
