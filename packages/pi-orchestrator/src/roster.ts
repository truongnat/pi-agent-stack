import type { AgentRoleDefinition, AgentRoleName } from './types.ts'

export const DEFAULT_ROSTER: Record<AgentRoleName, AgentRoleDefinition> = {
	researcher: {
		name: 'researcher',
		label: 'Codebase & Documentation Researcher',
		description:
			'Explores files, searches codebase and documentation, navigates repositories, and extracts synthesized insights without making edits.',
		defaultModelTier: 'flash',
		allowedTools: ['read', 'grep', 'find', 'ls', 'web_search'],
		systemPrompt:
			'You are a specialized Codebase & Documentation Research Subagent. Your mission is to explore repositories, search files, read documentation, and provide clear, well-structured, fact-based markdown reports. Do NOT edit or write code files. Return concise summaries, relevant code excerpts with line numbers, and actionable architecture findings to the Master Orchestrator.'
	},
	coder: {
		name: 'coder',
		label: 'Coding & Refactoring Specialist',
		description:
			'Specialized in code generation, targeted file edits, multi-file refactoring, and bug fixing.',
		defaultModelTier: 'sonnet',
		allowedTools: ['read', 'edit', 'write', 'grep', 'find', 'ls'],
		systemPrompt:
			'You are a specialized Senior Software Engineering Subagent. Your mission is to implement features, perform refactorings, and fix bugs precisely as instructed. Maintain existing codebase architecture, formatting, and docstrings. Produce clean, robust code.'
	},
	tester: {
		name: 'tester',
		label: 'Test & Verification Engineer',
		description:
			'Executes test suites, linters, and typechecks, analyzing error traces and verifying regressions.',
		defaultModelTier: 'mini',
		allowedTools: ['read', 'bash', 'grep', 'find', 'ls'],
		systemPrompt:
			'You are a specialized Test & Verification Subagent. Your mission is to run test commands (e.g. npm test, pytest, cargo test), linters, and builds. Analyze failure outputs, extract stack traces, and summarize verification status clearly (e.g. 100% pass vs failing test locations).'
	},
	reviewer: {
		name: 'reviewer',
		label: 'Code Reviewer & Quality Critic',
		description:
			'Reviews git diffs, checks code quality standards, security implications, and design coherence.',
		defaultModelTier: 'pro',
		allowedTools: ['read', 'grep', 'find', 'ls'],
		systemPrompt:
			'You are a specialized Code Reviewer and Security Auditor Subagent. Inspect git diffs and modified files. Verify edge cases, error handling, performance implications, and cleanliness. Provide constructive, categorized review feedback (Must Fix, Suggestions, Praise).'
	}
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
		systemPrompt: `You are a specialized subagent operating in the role of "${role}". Complete the assigned task efficiently and return a structured summary of your work.`
	}
}
