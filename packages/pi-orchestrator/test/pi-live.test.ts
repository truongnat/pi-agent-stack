import assert from 'node:assert/strict'
import test from 'node:test'
import {
	dashboardUrl,
	fallbackTabIsWatchingFromStatus,
	fallbackUrl,
	offlineHtml,
	portOpen,
	resolveDashboardTarget,
	serveOffline
} from '../../../scripts/pi-live.mjs'

test('dashboard and fallback urls stay on loopback', () => {
	assert.equal(dashboardUrl(4317), 'http://127.0.0.1:4317')
	assert.equal(fallbackUrl(4318), 'http://127.0.0.1:4318')
})

test('offline page names the live url and a retry control', () => {
	const html = offlineHtml('http://127.0.0.1:4317')
	assert.match(html, /Pi is not running/)
	assert.match(html, /http:\/\/127\.0\.0\.1:4317/)
	assert.match(html, /id="retry"/)
	assert.match(html, /mode: "no-cors"/)
	assert.match(html, /EventSource\("\/wait"\)/)
	assert.match(html, /\/handoff/)
})

test('fallbackTabIsWatchingFromStatus follows a live tab or a recent handoff', () => {
	assert.equal(fallbackTabIsWatchingFromStatus({ viewers: 1, handoffUntil: 0 }), true)
	assert.equal(fallbackTabIsWatchingFromStatus({ viewers: 0, handoffUntil: Date.now() + 1000 }), true)
	assert.equal(fallbackTabIsWatchingFromStatus({ viewers: 0, handoffUntil: Date.now() - 1000 }), false)
})

test('resolveDashboardTarget uses fallback when the live port is down', async () => {
	const target = await resolveDashboardTarget({
		livePort: 4317,
		fallbackPort: 4318,
		probe: async () => false
	})
	assert.deepEqual(target, {
		url: 'http://127.0.0.1:4318',
		mode: 'offline',
		livePort: 4317,
		fallbackPort: 4318,
		live: 'http://127.0.0.1:4317'
	})
})

test('resolveDashboardTarget uses live when the probe succeeds', async () => {
	const target = await resolveDashboardTarget({
		livePort: 4317,
		fallbackPort: 4318,
		probe: async () => true
	})
	assert.deepEqual(target, { url: 'http://127.0.0.1:4317', mode: 'live' })
})

test('fallback server serves the offline page', async () => {
	const port = 43190
	const server = await serveOffline('http://127.0.0.1:4317', port)
	try {
		assert.equal(await portOpen(port), true)
		const response = await fetch(`http://127.0.0.1:${port}/`)
		const body = await response.text()
		assert.equal(response.status, 200)
		assert.match(body, /Pi is not running/)
		const idle = await fetch(`http://127.0.0.1:${port}/status`)
		assert.deepEqual(await idle.json(), { viewers: 0, handoffUntil: 0 })
		const handoff = await fetch(`http://127.0.0.1:${port}/handoff`, { method: 'POST' })
		assert.equal(handoff.status, 204)
		const claimed = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as {
			viewers: number
			handoffUntil: number
		}
		assert.equal(claimed.viewers, 0)
		assert.ok(claimed.handoffUntil > Date.now())
		const abort = new AbortController()
		const waiting = fetch(`http://127.0.0.1:${port}/wait`, { signal: abort.signal })
		await new Promise((resolve) => setTimeout(resolve, 40))
		const liveView = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as {
			viewers: number
		}
		assert.equal(liveView.viewers, 1)
		abort.abort()
		await waiting.catch(() => {})
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error?: Error) => (error ? reject(error) : resolve()))
		)
	}
})
