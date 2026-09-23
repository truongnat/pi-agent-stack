/**
 * Strict environment allowlist for spawned CLI subprocesses.
 * Never pass through arbitrary process.env (avoids leaking unrelated secrets).
 */

const ALLOW = new Set([
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'TMPDIR',
	'TMP',
	'TEMP',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TERM',
	'COLORTERM',
	'SHELL',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'XDG_RUNTIME_DIR',
	'SSH_AUTH_SOCK',
	// Cursor / Antigravity may need locale and display for some installs
	'TZ',
	'NO_COLOR',
	'FORCE_COLOR'
])

export function allowlistEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {}
	for (const key of ALLOW) {
		const value = base[key]
		if (value !== undefined) out[key] = value
	}
	return out
}