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
import { noulOf, scoreOf, THRESHOLDS, type Answers } from './jev.ts'

export type RiskLevel = 0 | 1 | 2 | 3

export interface RiskEvaluation {
	level: RiskLevel
	category: 'safe' | 'process_lifecycle' | 'destructive_git' | 'mass_delete' | 'system_tampering' | 'credential_leak' | 'unknown'
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
		const cmd = String(event.input?.command || '').toLowerCase()

		// 1. Committing private credentials to git
		if (/git\s+add.*(\.env|\.pem|id_rsa|id_ed25519|credentials\.json)/i.test(cmd)) {
			return {
				level: 3,
				category: 'credential_leak',
				reason: 'Attempting to stage sensitive master credentials/keys into git',
				requireConfirm: true,
				blockDirectly: true
			}
		}

		// 2. Exfiltrating secrets via network to external domains
		if (
			/(curl|wget|nc|ncat|socat|telnet).*(-d|--data|--header|auth).*(\$|key|token|secret)/i.test(cmd) &&
			!/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(cmd)
		) {
			return {
				level: 3,
				category: 'credential_leak',
				reason: 'Possible outbound credential exfiltration via network command',
				requireConfirm: true,
				blockDirectly: true
			}
		}

		// 3. System root destruction
		if (/rm\s+(-rf?|-f)\s+(\/|\/\*|~|\~|\$HOME|\/System|\/Library|\/etc|\/usr)(\s|$|;|\*)/i.test(cmd)) {
			return {
				level: 3,
				category: 'system_tampering',
				reason: 'Critical destructive command targeting root or home directory',
				requireConfirm: true,
				blockDirectly: true
			}
		}

		// 4. Disk & file system tampering
		if (/(mkfs|dd\s+if=.*of=\/dev\/|chmod\s+-R\s+777\s+\/|chown\s+-R\s+root\s+\/)/i.test(cmd)) {
			return {
				level: 3,
				category: 'system_tampering',
				reason: 'Low-level disk format or master permission tampering detected',
				requireConfirm: true,
				blockDirectly: true
			}
		}
	}

	if (event.toolName === 'read' || event.toolName === 'edit' || event.toolName === 'write') {
		const path = String(event.input?.path || event.input?.file || event.input?.TargetFile || '')
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
 * Identifies Tier 2 Destructive Workspace Operations (Hard resets, force pushes, mass deletes).
 */
export function detectDestructiveWorkspaceOperations(command: string): RiskEvaluation | null {
	const lower = command.toLowerCase()

	// 1. Force push or branch deletion on remote
	if (/git\s+push\s+.*(--force|-f|\s+:\w+|\s+--delete\s+\w+)/i.test(lower)) {
		return {
			level: 2,
			category: 'destructive_git',
			reason: 'Force-pushing or deleting remote git branches can overwrite shared history',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	// 2. Hard reset that discards uncommitted/unpushed changes
	if (/git\s+reset\s+--hard/i.test(lower)) {
		return {
			level: 2,
			category: 'destructive_git',
			reason: '`git reset --hard` will permanently discard uncommitted working changes',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	// 3. Git clean that purges untracked files
	if (/git\s+clean\s+(-[a-z]*f[a-z]*d|-[a-z]*d[a-z]*f|-fdx|-fxd)/i.test(lower)) {
		return {
			level: 2,
			category: 'destructive_git',
			reason: '`git clean -fdx` permanently purges all untracked files and artifacts',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	// 4. Mass wildcard deletion in workspace
	if (/rm\s+-rf?\s+(\*|\.\/\*|\.\s)/i.test(lower)) {
		return {
			level: 2,
			category: 'mass_delete',
			reason: 'Mass wildcard deletion of all workspace files detected',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	// 5. Database drops or truncates
	if (/(drop\s+database|truncate\s+table)/i.test(lower)) {
		return {
			level: 2,
			category: 'mass_delete',
			reason: 'Database drop or table truncation command detected',
			requireConfirm: true,
			blockDirectly: false
		}
	}

	return null
}

/**
 * Comprehensive Multi-Tier Risk Evaluation Engine.
 */
export function evaluateRisk(
	event: ToolCallEvent,
	cwd: string,
	answers?: Answers
): RiskEvaluation {
	// 1. Check for Tier 3 Critical Hazards
	const critical = detectCriticalHazards(event, cwd)
	if (critical) return critical

	// 2. Analyze Bash commands
	if (event.toolName === 'bash') {
		const rawCmd = String(event.input?.command || '').trim()
		if (!rawCmd) {
			return { level: 0, category: 'safe', requireConfirm: false, blockDirectly: false }
		}

		// Check for Tier 2 Destructive operations
		const destructive = detectDestructiveWorkspaceOperations(rawCmd)
		if (destructive) return destructive

		// Split segments and verify if all parts are safe dev operations
		const segments = splitCommandSegments(rawCmd)
		const allSegmentsSafe = segments.length > 0 && segments.every(isSafeDevSegment)

		if (allSegmentsSafe) {
			return {
				level: 0,
				category: 'safe',
				requireConfirm: false,
				blockDirectly: false
			}
		}

		// If JEV answers are provided, inspect nuanced risk
		if (answers) {
			const risk = scoreOf(answers, 'risk')
			if (risk.confidence >= THRESHOLDS.askConfidence) {
				const lvl = Math.round(risk.score)
				if (lvl === 3) {
					return {
						level: 3,
						category: 'system_tampering',
						reason: `Destructive command flagged by JEV System 1 (${risk.confidence.toFixed(2)})`,
						requireConfirm: true,
						blockDirectly: false
					}
				}
				if (lvl === 2) {
					// Only confirm if it is actually destructive (not benign script execution)
					const isBenignScript = /^(node|bun|python3?|bash|sh|\.\/)\s+[\w./-]+\.(js|ts|py|sh|mjs)/.test(rawCmd.toLowerCase())
					if (!isBenignScript) {
						return {
							level: 2,
							category: 'unknown',
							reason: `Action flagged as hard to reverse by JEV System 1 (${risk.confidence.toFixed(2)})`,
							requireConfirm: true,
							blockDirectly: false
						}
					}
				}
			}
		}

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
