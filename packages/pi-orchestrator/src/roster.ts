import type { AgentRoleDefinition, AgentRoleName } from './types.ts'

const LANGUAGE_DIRECTIVE =
	'CRITICAL: Always respond and synthesize reports in the exact same language as the task prompt (default to Vietnamese or English as used in the prompt). Never produce output in unrelated foreign languages (e.g. Mongolian, Russian, etc.).'

export const DEFAULT_ROSTER: Record<AgentRoleName, AgentRoleDefinition> = {
	researcher: {
		name: 'researcher',
		label: 'Codebase & Documentation Researcher',
		description:
			'Explores files, searches codebase and documentation, navigates repositories, and extracts synthesized insights without making edits.',
		defaultModelTier: 'flash',
		allowedTools: ['read', 'grep', 'find', 'ls'],
		systemPrompt: `You are a specialized Codebase & Documentation Research Subagent. Your mission is to explore repositories, search files, read documentation, and provide clear, well-structured, fact-based markdown reports. Do NOT edit or write code files. Return concise summaries, relevant code excerpts with line numbers, and actionable architecture findings to the Master Orchestrator. ${LANGUAGE_DIRECTIVE}`
	},
	coder: {
		name: 'coder',
		label: 'Coding & Refactoring Specialist',
		description:
			'Specialized in code generation, targeted file edits, multi-file refactoring, and bug fixing.',
		defaultModelTier: 'sonnet',
		allowedTools: ['read', 'edit', 'write', 'grep', 'find', 'ls'],
		systemPrompt: `You are a specialized Senior Software Engineering Subagent. Your mission is to implement features, perform refactorings, and fix bugs precisely as instructed. Maintain existing codebase architecture, formatting, and docstrings. Produce clean, robust code. ${LANGUAGE_DIRECTIVE}`
	},
	tester: {
		name: 'tester',
		label: 'Test & Verification Engineer',
		description:
			'Executes test suites, linters, and typechecks, analyzing error traces and verifying regressions.',
		defaultModelTier: 'mini',
		allowedTools: ['read', 'bash', 'grep', 'find', 'ls'],
		systemPrompt: `You are a specialized Test & Verification Subagent. Your mission is to run test commands (e.g. npm test, pytest, cargo test), linters, and builds. Analyze failure outputs, extract stack traces, and summarize verification status clearly (e.g. 100% pass vs failing test locations). ${LANGUAGE_DIRECTIVE}`
	},
	debugger: {
		name: 'debugger',
		label: 'Root-Cause & Exception Diagnostic Specialist',
		description:
			'Investigates runtime crashes, unhandled exceptions, server error logs, and monorepo surface issues without guessing.',
		defaultModelTier: 'flash',
		allowedTools: ['read', 'bash', 'grep', 'find', 'ls'],
		systemPrompt: `You are a specialized Root-Cause & Exception Diagnostic Subagent. Your mission is to isolate target runtime surfaces (e.g. Mobile, Web, API), inspect log outputs, extract exact stack traces and error messages, and identify the root cause cleanly before recommending or applying fixes. ${LANGUAGE_DIRECTIVE}`
	},
	reviewer: {
		name: 'reviewer',
		label: 'Code Reviewer & Quality Critic',
		description:
			'Reviews git diffs, checks code quality standards, security implications, and design coherence.',
		defaultModelTier: 'pro',
		allowedTools: ['read', 'grep', 'find', 'ls'],
		systemPrompt: `You are a specialized Code Reviewer and Security Auditor Subagent. Inspect git diffs and modified files. Verify edge cases, error handling, performance implications, and cleanliness. Provide constructive, categorized review feedback (Must Fix, Suggestions, Praise). ${LANGUAGE_DIRECTIVE}`
	}
}

const ROLE_CODENAMES: Record<string, string[]> = {
	researcher: [
		'Athena',
		'Galileo',
		'Hypatia',
		'DaVinci',
		'Kepler',
		'Copernicus',
		'Curie',
		'Hubble',
		'Sagan',
		'Feynman'
	],
	coder: [
		'Daedalus',
		'Turing',
		'Lovelace',
		'Archimedes',
		'Torvalds',
		'Neumann',
		'Knuth',
		'Babbage',
		'Wozniak',
		'Ritchie'
	],
	tester: [
		'Sentinel',
		'Aegis',
		'Vanguard',
		'Heisen',
		'Cerberus',
		'Argus',
		'Hyperion',
		'Titan',
		'Fortress',
		'Valkyrie'
	],
	debugger: [
		'Sherlock',
		'Oracle',
		'Spectre',
		'Falcon',
		'Chiron',
		'Apollo',
		'Osiris',
		'Cipher',
		'Nexus',
		'Prometheus'
	],
	reviewer: [
		'Justitia',
		'Aristotle',
		'Minerva',
		'Solon',
		'Marcus',
		'Themis',
		'Seneca',
		'Cato',
		'Plato',
		'Astraea'
	]
}

const FALLBACK_CODENAMES = [
	'Atlas',
	'Nova',
	'Orion',
	'Apex',
	'Helios',
	'Zephyr',
	'Phoenix',
	'Quantum',
	'Valkyrie',
	'Genesis'
]

let codenameCounter = 0

/**
 * Generates an elegant, prestigious codename for a subagent based on role and context.
 */
export function generateAgentCodename(
	role: AgentRoleName,
	customName?: string,
	prompt?: string
): string {
	if (customName && customName.trim() && !/^(\w+)_[a-z0-9]{4,6}$/.test(customName)) {
		return customName.trim()
	}

	const pool = ROLE_CODENAMES[role.toLowerCase()] || FALLBACK_CODENAMES
	const index = codenameCounter++ % pool.length
	const codename = pool[index]!

	// If prompt contains clear intent, extract a short tag (optional)
	let topicTag = ''
	if (prompt) {
		const cleanPrompt = prompt.replace(/[^\w\s-]/g, '').trim()
		const words = cleanPrompt
			.split(/\s+/)
			.filter(
				(w) =>
					w.length > 2 &&
					!/^(the|and|for|with|this|that|from|into|about|survey|check|find|read|write|test|review)$/i.test(
						w
					)
			)
		if (words.length > 0) {
			topicTag = words
				.slice(0, 2)
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
				.join('')
		}
	}

	return topicTag ? `${codename} · ${topicTag}` : codename
}

export function getRoleDefinition(role: AgentRoleName): AgentRoleDefinition {
	if (DEFAULT_ROSTER[role]) {
		return DEFAULT_ROSTER[role]
	}

	// Dynamic fallback for custom roles
	return {
		name: role,
		label: `Custom Subagent (${role})`,
		description: `Custom subagent with role: ${role}`,
		defaultModelTier: 'flash',
		allowedTools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
		systemPrompt: `You are a specialized subagent operating in the role of "${role}". Complete the assigned task efficiently and return a structured summary of your work. ${LANGUAGE_DIRECTIVE}`
	}
}
