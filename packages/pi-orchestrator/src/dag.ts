/**
 * Task graphs for invoke_subagent: tasks name each other by `id` and wait on `depends_on`.
 * Pure functions; the manager runs the schedule.
 */
import type { SubagentExecutionResult, SubagentTask } from './types.ts'

export type DagNode = SubagentTask & { id: string; dependsOn: string[] }

/** Dependency output carried into a dependent's prompt; the rest stays in its scratchpad. */
export const DEP_OUTPUT_CHARS = 4000

/**
 * Gives every task an id (`t1`, `t2`, … when missing) and validates the graph: unique ids,
 * known dependencies, no cycles. Returns the nodes or a message naming what is wrong.
 */
export function planDag(tasks: SubagentTask[]): { nodes: DagNode[] } | { error: string } {
	const nodes = tasks.map((t, i) => ({
		...t,
		id: t.id?.trim() || `t${i + 1}`,
		dependsOn: t.dependsOn ?? []
	}))
	const ids = new Set<string>()
	for (const n of nodes) {
		if (ids.has(n.id)) return { error: `Duplicate task id "${n.id}".` }
		ids.add(n.id)
	}
	for (const n of nodes) {
		const unknown = n.dependsOn.filter((d) => !ids.has(d))
		if (unknown.length > 0)
			return { error: `Task "${n.id}" depends on unknown id(s): ${unknown.join(', ')}.` }
		if (n.dependsOn.includes(n.id)) return { error: `Task "${n.id}" depends on itself.` }
	}
	// Kahn: whatever never reaches in-degree 0 sits on a cycle.
	const indegree = new Map(nodes.map((n) => [n.id, n.dependsOn.length]))
	const queue = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id)
	let visited = 0
	while (queue.length > 0) {
		const id = queue.shift()!
		visited++
		for (const n of nodes) {
			if (!n.dependsOn.includes(id)) continue
			const left = (indegree.get(n.id) ?? 0) - 1
			indegree.set(n.id, left)
			if (left === 0) queue.push(n.id)
		}
	}
	if (visited < nodes.length) {
		const cycle = nodes.filter((n) => (indegree.get(n.id) ?? 0) > 0).map((n) => n.id)
		return { error: `Dependency cycle between: ${cycle.join(', ')}.` }
	}
	return { nodes }
}

/** The task's prompt plus the results of the tasks it waited on. */
export function promptWithDependencies(
	node: DagNode,
	done: Map<string, SubagentExecutionResult>
): string {
	if (node.dependsOn.length === 0) return node.prompt
	const sections = node.dependsOn.map((id) => {
		const r = done.get(id)
		const output = r?.output ?? ''
		const clipped =
			output.length > DEP_OUTPUT_CHARS
				? `${output.slice(0, DEP_OUTPUT_CHARS)}\n…[truncated; full output: ${r?.scratchpadDir}/output.md]`
				: output
		return `### ${id} (${r?.role ?? 'unknown'})\n${clipped}`
	})
	return `${node.prompt}\n\nResults from the tasks this one depends on:\n\n${sections.join('\n\n')}`
}

/** Tree view for /agents dag: one line per task with its status and what it waits on. */
export function renderDag(nodes: DagNode[], status: Map<string, string>): string {
	if (nodes.length === 0) return 'No task graph has run in this session yet.'
	const icons: Record<string, string> = {
		completed: '✓',
		running: '▶',
		failed: '✖',
		killed: '✖',
		skipped: '⤼'
	}
	const icon = (s: string | undefined) => (s && icons[s]) || '·'
	const lines = nodes.map((n) => {
		const s = status.get(n.id)
		const deps = n.dependsOn.length > 0 ? ` ← ${n.dependsOn.join(', ')}` : ''
		return `${icon(s)} ${n.id} [${n.role}] ${s ?? 'pending'}${deps}`
	})
	return ['```', ...lines, '```'].join('\n')
}
