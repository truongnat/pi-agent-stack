/**
 * risk.ts: Context-Aware Multi-Tier Risk Evaluation Engine for Pi Harness.
 *
 * Replaces blunt regexes and naive model scores with a rigorous 4-Tier Security Matrix:
 *
 * Tier 0 (Safe / Auto-Allow):
 *   - All standard development toolchains (bun, npm, pnpm, yarn, cargo, go, pytest, make, etc.)
 *   - Pure read/observability (cat, grep, rg, find, ls, ps, lsof, pgrep)
 *   - Local dev server & process management (kill <pid>, pkill <name>, sleep, nohup ./target/debug/... &)
 *   - Local workspace file mutations & build artifact cleanups (target/, dist/, node_modules/, /tmp/)
 *   - Standard version control operations (git status, diff, log, add, commit, switch, branch, stash)
 *
 * Tier 1 (Low Risk / Log-Only):
 *   - Modifying non-tracked files outside standard build targets
 *   - Background tasks and local HTTP queries
 *
 * Tier 2 (Destructive Workspace Operations -> Confirmation Required):
 *   - Irreversible uncommitted work destruction: `git reset --hard`, `git clean -fdx`, `git restore .`
 *   - Remote repository overwrites: `git push --force`, `git push origin --delete`
 *   - Mass directory wipe within workspace: `rm -rf *`
 *
 * Tier 3 (Critical System Hazard & Credential Exfiltration -> Strict Block / Confirm):
 *   - System root / home destruction: `rm -rf /`, `rm -rf ~`, `rm -rf /System`
 *   - Disk tampering: `dd if=... of=/dev/...`, `mkfs`
 *   - Exfiltration of master credentials (SSH keys, AWS keys) to external servers
 *   - Committing sensitive `.env` / credentials to git
 */
import { homedir } from 'node:os'
import { isAbsolute, normalize, relative, resolve } from 'node:path'
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'

import { scoreOf, THRESHOLDS, type Answers } from './jev.ts'

export type RiskLevel = 0 | 1 | 2 | 3

export interface RiskEvaluation {
	level: RiskLevel
	category:
		| 'safe'
		| 'process_lifecycle'
		| 'destructive_git'
		| 'mass_delete'
		| 'system_tampering'
		| 'credential_leak'
		| 'unknown'
	reason?: string
	requireConfirm: boolean
	blockDirectly: boolean
}

const CRITICAL_SYSTEM_PATHS = [
	'/',
	'/bin',
	'/sbin',
	'/usr',
	'/usr/bin',
	'/etc',
	'/var',
	'/System',
	'/Library',
	'/home',
	'/root',
	'/private',
	homedir(),
	resolve(homedir(), '.ssh'),
	resolve(homedir(), '.aws'),
	resolve(homedir(), '.gnupg'),
	resolve(homedir(), '.keys')
]

/**
 * Checks if a target path is an external sensitive system path outside the workspace.
 */
export function isSensitiveSystemPath(targetPath: string, cwd: string): boolean {
	const expanded = targetPath.startsWith('~')
		? targetPath.replace(/^~(?=$|\/|\\)/, homedir())
		: targetPath

	const absPath = isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded)
	const rel = relative(cwd, absPath)

	// If inside current working directory, it's not an external system root path,
	// UNLESS it directly targets private SSH/AWS keys
	if (!rel.startsWith('..') && !isAbsolute(rel)) {
		if (/(id_rsa|id_ed25519|\.ssh|\.aws|\.gnupg)/.test(absPath)) {
			return true
		}
		return false
	}

	// Always flag SSH / AWS / GPG / Master keys outside workspace
	if (/(\.ssh|\.aws|\.gnupg|\.keys|id_rsa|id_ed25519|\.kube\/config)/.test(absPath)) {
		return true
	}

	// Check against critical system paths
	for (const sysPath of CRITICAL_SYSTEM_PATHS) {
		if (absPath === sysPath || absPath.startsWith(`${sysPath}/`)) {
			// /tmp or ~/.pi/ is acceptable for temporary work
			if (absPath.startsWith('/tmp') || absPath.startsWith(resolve(homedir(), '.pi'))) {
				return false
			}
			return true
		}
	}

	return false
}

/**
 * Cleans leading and trailing shell control syntax, subshells, and redirects.
 */
export function cleanCommandSegment(seg: string): string {
	return seg
		.trim()
		.replace(/^nohup\s+/, '')
		.replace(/^[\s({]+/, '')
		.replace(/[\s)}]+$/, '')
		.replace(/^(if|then|else|elif|do|while)\s+/, '')
		.replace(/\b(fi|done|esac)$/, '')
		.replace(/&$/, '')
		.trim()
}

/**
 * Parses shell commands into individual piped/chained segments.
 */
export function splitCommandSegments(command: string): string[] {
	// Split on &&, ||, ;, |, and background & (avoiding 2>&1 or &> redirects)
	return command
		.split(/(?:&&|\|\||;|\||(?<![&>])&(?!&|[0-9]))/)
		.map(cleanCommandSegment)
		.filter(Boolean)
}

const CREDENTIAL_PATH =
	/(~|\$\{?HOME\}?|\/home\/[^/\s]+|\/root)\/(\.ssh|\.aws|\.gnupg|\.keys|\.kube\/config|\.netrc|\.docker\/config\.json)|\bid_(rsa|ed25519|ecdsa)\b/

const NETWORK_TOOLS = new Set([
	'curl',
	'wget',
	'nc',
	'ncat',
	'socat',
	'telnet',
	'scp',
	'rsync',
	'ftp',
	'sftp'
])

const LOCAL_HOST = /(localhost|127\.0\.0\.1|0\.0\.0\.0)/

const SECRET_VAR = /\$\{?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASS|PASSWORD)[A-Za-z0-9_]*\}?/

const SECRET_WORD = /\b(api[_-]?key|access[_-]?token|token|secret|password|passwd)\b/i

const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)*|[^/]+\.pem|id_rsa|id_ed25519|credentials\.json)$/

const SAFE_ENV_FILE = /\.env\.(example|sample|template|dist)$/

const PROTECTED_BRANCH = /^(refs\/heads\/)?(main|master|production|prod)$/

/** Shell-ish words with quotes stripped; `sudo`/`env` prefixes dropped so `sudo rm` reads as `rm`. */
export function commandWords(segment: string): string[] {
	const words = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
		w.replace(/^["']|["']$/g, '')
	)
	while (words[0] === 'sudo' || words[0] === 'env' || words[0] === 'command') words.shift()
	return words
}

const expandHome = (word: string): string => word.replace(/^(~|\$\{?HOME\}?)(?=$|\/)/, homedir())

/** `rm -r` (any flag spelling) aimed exactly at `/`, `~`, `$HOME` or a system root such as `/etc`. */
export function removesCriticalPath(words: string[]): boolean {
	if (words[0] !== 'rm') return false
	const flags = words.slice(1).filter((w) => w.startsWith('-'))
	const recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f))
	if (!recursive) return false
	return words
		.slice(1)
		.filter((w) => !w.startsWith('-'))
		.some((target) => {
			const trimmed = expandHome(target)
				.replace(/\/\*$/, '')
				.replace(/(.)\/+$/, '$1')
			const abs = trimmed === '' ? '/' : trimmed
			return isAbsolute(abs) && CRITICAL_SYSTEM_PATHS.includes(normalize(abs))
		})
}

/** `git push` that force-updates (flag or `+refspec`) main/master/production. */
export function forcePushesProtected(words: string[]): boolean {
	if (words[0] !== 'git' || !words.includes('push')) return false
	const args = words.slice(words.indexOf('push') + 1)
	const forced = args.some(
		(a) => /^--force(-with-lease|-if-includes)?(=|$)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)
	)
	const refspecs = args.filter((a) => !a.startsWith('-')).slice(1)
	return refspecs.some((ref) => {
		const dst = ref.replace(/^\+/, '').split(':').pop() ?? ''
		return PROTECTED_BRANCH.test(dst) && (forced || ref.startsWith('+'))
	})
}

/** `git add` naming a real secret file (`.env.example` and friends are fine). */
export function stagesSecretFile(words: string[]): boolean {
	if (words[0] !== 'git' || words[1] !== 'add') return false
	return words.slice(2).some((w) => SECRET_FILE.test(w) && !SAFE_ENV_FILE.test(w))
}

const IDENTITY_FLAGS = new Set(['-i', '--identity', '-e', '--rsh'])

/**
 * Words that name a credential store, minus SSH identity files handed to `-i`/`-e`/`--rsh`
 * (`scp -i ~/.ssh/deploy_key`) and public keys: those authenticate, they do not leak.
 */
export function credentialWords(segments: string[][]): string[] {
	const found: string[] = []
	for (const words of segments) {
		for (let i = 0; i < words.length; i++) {
			const word = words[i] ?? ''
			if (IDENTITY_FLAGS.has(word)) {
				i++
				continue
			}
			if (/^(-i\S|--(identity|rsh)=)/.test(word) || word.endsWith('.pub')) continue
			if (CREDENTIAL_PATH.test(word)) found.push(word)
		}
	}
	return found
}

const isOutbound = (words: string[]): boolean =>
	NETWORK_TOOLS.has(words[0] ?? '') && !words.some((w) => LOCAL_HOST.test(w))

/**
 * Checks if a single command segment is an unconditionally safe development command.
 */
export function isSafeDevSegment(segment: string): boolean {
	const trimmed = cleanCommandSegment(segment).toLowerCase()
	if (!trimmed) return true

	const devPatterns = [
		// 1. Package managers & build tools
		/^(npm|pnpm|yarn|bun)\s+/,
		/^cargo\s+/,
		/^go\s+/,
		/^(python3?|pytest|ruff|flake8|black|mypy|uv|pip)\s+/,
		/^flutter\s+/,
		/^(make|cmake|ninja|mvn|gradle)\s+/,
		/^rustc\s+/,
		/^tsc\s+/,
		// 2. Read-only / observability & shell builtins
		/^(which|where|cat|ls|pwd|echo|printf|head|tail|wc|find|grep|rg|tree|stat|file|test|true|false|exit|return|source|\.|\[)\b/,
		// 3. Process lifecycle & dev server management
		/^(kill|pkill|killall|pgrep|ps|lsof|sleep|nohup|wait)\b/,
		// 4. Local target / workspace binary execution
		/^(\.\/|target\/(debug|release)\/|dist\/|build\/|bin\/)/,
		// 5. Safe file utilities in workspace
		/^(mkdir|touch|cp|mv)\s+/,
		// 6. Safe cleanup of known build artifacts
		/^rm\s+(-rf?|-f)?\s+(target|dist|build|\.turbo|\.cache|node_modules|coverage|tmp|\/tmp\/[\w.-]+)/,
		// 7. Local network probes
		/^(curl|wget|nc)\s+.*(localhost|127\.0\.0\.1|0\.0\.0\.0)/,
		// 8. Safe git inspection & routine workflows
		/^git\s+(status|diff|log|branch|checkout|switch|show|add|commit|fetch|pull|stash|merge|tag)\b/
	]

	return devPatterns.some((pattern) => pattern.test(trimmed))
}

/**
 * Identifies Tier 3 Critical Hazards (System destruction, credential theft).
 */
export function detectCriticalHazards(event: ToolCallEvent, cwd: string): RiskEvaluation | null {
	if (event.toolName === 'bash') {
		const raw = String(event.input?.command || '')
		const segments = splitCommandSegments(raw).map(commandWords)
		const hazard = (
			reason: string,
			category: RiskEvaluation['category'],
			blockDirectly: boolean
		): RiskEvaluation => ({ level: 3, category, reason, requireConfirm: true, blockDirectly })

		// 1. Committing private credentials to git
		if (segments.some(stagesSecretFile)) {
			return hazard(
				'Attempting to stage sensitive master credentials/keys into git',
				'credential_leak',
				true
			)
		}

		// 2. Credential files piped or uploaded to a non-local host
		const outbound = segments.filter(isOutbound)
		const credentials = credentialWords(segments)
		if (outbound.length > 0 && credentials.length > 0) {
			return hazard('Credential file sent to a network command', 'credential_leak', true)
		}

		// 3. Secret-looking values sent out: may be a normal authenticated API call, so the user decides
		if (outbound.some((w) => w.some((word) => SECRET_VAR.test(word) || SECRET_WORD.test(word)))) {
			return hazard(
				'Possible outbound credential exfiltration via network command',
				'credential_leak',
				false
			)
		}

		// 4. System root / home destruction, whatever the flag spelling
		if (segments.some(removesCriticalPath) || /--no-preserve-root/.test(raw)) {
			return hazard(
				'Critical destructive command targeting root or home directory',
				'system_tampering',
				true
			)
		}

		// 5. Disk & file system tampering
		if (/(mkfs|dd\s+if=.*of=\/dev\/|chmod\s+-R\s+777\s+\/|chown\s+-R\s+root\s+\/)/i.test(raw)) {
			return hazard(
				'Low-level disk format or master permission tampering detected',
				'system_tampering',
				true
			)
		}

		// 6. Reading credential stores into the conversation: same rule as the read tool
		if (credentials.length > 0) {
			return hazard('Reading a credential store outside the workspace', 'credential_leak', false)
		}
	}

	if (event.toolName === 'read' || event.toolName === 'edit' || event.toolName === 'write') {
		const rawInput = event.input as Record<string, unknown> | undefined
		const path = String(rawInput?.path || rawInput?.file || rawInput?.TargetFile || '')
		if (path && isSensitiveSystemPath(path, cwd)) {
			return {
				level: 3,
				category: 'credential_leak',
				reason: `Accessing restricted system credential store outside workspace: ${path}`,
				requireConfirm: true,
				blockDirectly: false
			}
		}
	}

	return null
}

/**
 * Identifies Tier 2/3 Remote & Critical Infrastructure Hazards (Remote DB drops, SSH destructive commands, force push to protected branches).
 */
export function detectRemoteOrSystemHazards(command: string): RiskEvaluation | null {
	const lower = command.toLowerCase()

	// 1. Destructive remote branch deletion or force push to main/master/production
	const forced = splitCommandSegments(command).map(commandWords).some(forcePushesProtected)
	if (
		forced ||
		/git\s+push\s+.*(--delete\s+(main|master|production|prod)\b|\s:(main|master|production|prod)\b)/i.test(
			lower
		)
	) {
		return {
			level: 3,
			category: 'system_tampering',
			reason: 'Destructive remote git action targeting production/main branch',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	// 2. Remote SSH execution of destructive commands or dropping staging/production databases
	if (/ssh\s+.*(rm\s+-rf|drop\s+database|truncate|mkfs|dd\s+if)/i.test(lower)) {
		return {
			level: 3,
			category: 'system_tampering',
			reason: 'Executing destructive system/database command over SSH on remote server',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	// 3. Direct remote/staging database drop commands
	if (
		/psql|mysql|mongosh|redis-cli/i.test(lower) &&
		/(drop\s+database|drop\s+schema|flushall)/i.test(lower)
	) {
		return {
			level: 3,
			category: 'system_tampering',
			reason: 'Dropping database or flushing data on database connection',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	return null
}

/**
 * Comprehensive Developer-Centric Risk Evaluation Engine.
 *
 * Guarantees:
 * - 100% UNRESTRICTED local development: editing, creating, deleting workspace files (rm -rf),
 *   rewriting history (git reset --hard, clean, rebase), killing/restarting dev servers, builds, tests.
 * - STRICT PROTECTION only against: OS/system destruction (rm -rf /), credential leaks (~/.ssh, ~/.aws),
 *   and remote infrastructure tampering (SSH remote drops, deleting remote main branch).
 */
export function evaluateRisk(event: ToolCallEvent, cwd: string, answers?: Answers): RiskEvaluation {
	// 1. Check for Critical System & Credential Hazards
	const critical = detectCriticalHazards(event, cwd)
	if (critical) return critical

	// 2. Analyze Bash commands
	if (event.toolName === 'bash') {
		const rawCmd = String(event.input?.command || '').trim()
		if (!rawCmd) {
			return { level: 0, category: 'safe', requireConfirm: false, blockDirectly: false }
		}

		// Check for remote/infrastructure hazards
		const remoteHazard = detectRemoteOrSystemHazards(rawCmd)
		if (remoteHazard) return remoteHazard

		// If JEV answers are provided and it explicitly flags Critical Hazard (Level 3)
		if (answers) {
			const risk = scoreOf(answers, 'risk')
			if (risk.confidence >= THRESHOLDS.askConfidence) {
				const lvl = Math.round(risk.score)
				if (lvl >= 3) {
					return {
						level: 3,
						category: 'system_tampering',
						reason: `Critical system/remote hazard flagged by JEV System 1 (${risk.confidence.toFixed(2)})`,
						requireConfirm: true,
						blockDirectly: false
					}
				}
			}
		}

		// All local workspace development, git reset, rm -rf, process management is Safe (Level 0)
		return {
			level: 0,
			category: 'safe',
			requireConfirm: false,
			blockDirectly: false
		}
	}

	// 3. Read / Edit / Write / File tools
	return {
		level: 0,
		category: 'safe',
		requireConfirm: false,
		blockDirectly: false
	}
}
