import assert from 'node:assert/strict'
import test from 'node:test'
import {
	dashboardPublicUrl,
	openDashboardInBrowser,
	publishDashboardAgentUpdate,
	shouldOpenDashboardBrowser
} from '../src/dashboard.ts'

test('shouldOpenDashboardBrowser is on for an interactive TTY session', () => {
	assert.equal(shouldOpenDashboardBrowser({ PI_DASHBOARD_PORT: '4317' }, true), true)
})

test('shouldOpenDashboardBrowser stays off for print mode, workers, and explicit disable', () => {
	assert.equal(shouldOpenDashboardBrowser({}, false), false)
	assert.equal(shouldOpenDashboardBrowser({ PI_SUBAGENT_WORKER: '1' }, true), false)
	assert.equal(shouldOpenDashboardBrowser({ PI_DASHBOARD_HOST: '1' }, true), false)
	assert.equal(shouldOpenDashboardBrowser({ PI_DASHBOARD_OPEN: '0' }, true), false)
})

test('openDashboardInBrowser uses open on macOS and skips when disabled', async () => {
	const spawned: { cmd: string; args: string[] }[] = []
	const spawnFn = ((cmd: string, args: string[]) => {
		spawned.push({ cmd, args })
		return { unref() {} }
	}) as typeof import('node:child_process').spawn
	const hasFallbackTab = async () => false

	await openDashboardInBrowser('http://127.0.0.1:4317', {
		env: { PI_DASHBOARD_OPEN: '0' },
		tty: true,
		platform: 'darwin',
		spawnFn,
		hasFallbackTab
	})
	assert.equal(spawned.length, 0)

	await openDashboardInBrowser('http://127.0.0.1:4317', {
		env: {},
		tty: true,
		platform: 'darwin',
		spawnFn,
		hasFallbackTab
	})
	assert.deepEqual(spawned, [{ cmd: 'open', args: ['http://127.0.0.1:4317'] }])
	assert.match(dashboardPublicUrl(), /^http:\/\/127\.0\.0\.1:\d+$/)
})

test('openDashboardInBrowser keeps the existing fallback tab', async () => {
	const spawned: { cmd: string; args: string[] }[] = []
	const spawnFn = ((cmd: string, args: string[]) => {
		spawned.push({ cmd, args })
		return { unref() {} }
	}) as typeof import('node:child_process').spawn

	await openDashboardInBrowser('http://127.0.0.1:4317', {
		env: {},
		tty: true,
		platform: 'darwin',
		spawnFn,
		hasFallbackTab: async () => true
	})
	assert.equal(spawned.length, 0)
})

test('publishDashboardAgentUpdate does not throw without an attached session', () => {
	publishDashboardAgentUpdate('', [{ id: 'a', status: 'running' }], [])
})
