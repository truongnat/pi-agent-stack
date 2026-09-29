#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 4317
export const DEFAULT_FALLBACK_PORT = 4318

export function dashboardUrl(port = Number(process.env.PI_DASHBOARD_PORT || DEFAULT_PORT)) {
	return `http://127.0.0.1:${port}`
}

export function fallbackUrl(
	port = Number(process.env.PI_DASHBOARD_FALLBACK_PORT || DEFAULT_FALLBACK_PORT)
) {
	return `http://127.0.0.1:${port}`
}

export function portOpen(port, host = '127.0.0.1', timeoutMs = 400) {
	return new Promise((resolve) => {
		const socket = connect({ host, port })
		const done = (up) => {
			socket.removeAllListeners()
			socket.on('error', () => {})
			socket.destroy()
			resolve(up)
		}
		socket.setTimeout(timeoutMs, () => done(false))
		socket.once('connect', () => done(true))
		socket.once('error', () => done(false))
	})
}

export function offlineHtml(live) {
	const liveJson = JSON.stringify(live)
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0b0d12" />
  <title>Pi Live — Offline</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      display: grid;
      min-height: 100vh;
      place-items: center;
      padding: 24px 20px;
      background: #0b0d12;
      color: #e7ecf4;
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    main {
      width: min(440px, 100%);
      padding: 28px 28px 24px;
      border: 1px solid #2c3340;
      border-radius: 14px;
      background: #141821;
    }
    .mark {
      display: grid;
      width: 40px;
      height: 40px;
      place-items: center;
      margin-bottom: 18px;
      border: 1px solid #31574f;
      border-radius: 12px;
      background: #12221f;
      color: #63dfc1;
    }
    .mark svg { display: block; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
      color: #eb8383;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .status i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    p { margin: 0; color: #9aa5b5; }
    pre {
      overflow: auto;
      margin: 18px 0 0;
      padding: 10px 12px;
      border: 1px solid #2a3140;
      border-radius: 8px;
      background: #0e1118;
      color: #d9e0ea;
      font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-top: 20px;
    }
    button {
      min-height: 40px;
      padding: 8px 14px;
      border: 1px solid #31574f;
      border-radius: 8px;
      background: #15221f;
      color: #63dfc1;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #1a2c27; }
    button:focus-visible { outline: 2px solid #d7dee8; outline-offset: 2px; }
    .hint { color: #768195; font-size: 13px; }
    @media (prefers-reduced-motion: reduce) {
      .status i { animation: none; }
    }
    @media (prefers-reduced-motion: no-preference) {
      .status i { animation: pulse 1.4s ease-in-out infinite; }
    }
    @keyframes pulse { 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <main>
    <span class="mark" aria-hidden="true">
      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
      </svg>
    </span>
    <p class="status"><i></i>Offline</p>
    <h1>Pi is not running</h1>
    <p>Start a Pi session in the terminal. This page retries automatically and opens the live dashboard when it is ready.</p>
    <pre><code>pi</code></pre>
    <div class="row">
      <button type="button" id="retry">Try again</button>
      <span class="hint" id="hint" aria-live="polite">Waiting for Pi…</span>
    </div>
  </main>
  <script>
    const LIVE = ${liveJson};
    const hint = document.getElementById("hint");
    new EventSource("/wait");
    async function probe() {
      try {
        await fetch(LIVE, { mode: "no-cors", cache: "no-store" });
        hint.textContent = "Opening dashboard…";
        try { await fetch("/handoff", { method: "POST", cache: "no-store" }); } catch {}
        location.replace(LIVE);
      } catch {
        hint.textContent = "Waiting for Pi…";
      }
    }
    document.getElementById("retry").addEventListener("click", probe);
    probe();
    setInterval(probe, 1500);
  </script>
</body>
</html>
`
}

export function openBrowser(url, platform = process.platform, spawnFn = spawn) {
	if (platform === 'darwin') {
		spawnFn('open', [url], { detached: true, stdio: 'ignore' }).unref()
		return
	}
	if (platform === 'win32') {
		spawnFn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
		return
	}
	spawnFn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

export function serveOffline(live, fallbackPort) {
	const html = offlineHtml(live)
	const waiters = new Set()
	let handoffUntil = 0
	const csp =
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src " +
		live +
		" 'self'"
	const server = createServer((req, res) => {
		const path = (req.url ?? '/').split('?')[0]
		if (path === '/status') {
			res.writeHead(200, {
				'content-type': 'application/json',
				'cache-control': 'no-store',
				'access-control-allow-origin': '*'
			})
			res.end(
				JSON.stringify({
					viewers: waiters.size,
					handoffUntil
				})
			)
			return
		}
		if (path === '/handoff' && req.method === 'POST') {
			handoffUntil = Date.now() + 20_000
			res.writeHead(204, { 'cache-control': 'no-store' }).end()
			return
		}
		if (path === '/wait') {
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive'
			})
			waiters.add(res)
			res.write('data: waiting\n\n')
			req.on('close', () => waiters.delete(res))
			return
		}
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'content-security-policy': csp
		})
		res.end(html)
	})
	return new Promise((resolve, reject) => {
		server.on('error', reject)
		server.listen(fallbackPort, '127.0.0.1', () => resolve(server))
	})
}

export function fallbackTabIsWatchingFromStatus(data, now = Date.now()) {
	if (!data || typeof data !== 'object') return false
	if ((data.viewers ?? 0) > 0) return true
	return Number(data.handoffUntil) > now
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function resolveDashboardTarget({
	livePort = Number(process.env.PI_DASHBOARD_PORT || DEFAULT_PORT),
	fallbackPort = Number(process.env.PI_DASHBOARD_FALLBACK_PORT || DEFAULT_FALLBACK_PORT),
	probe = portOpen
} = {}) {
	const live = dashboardUrl(livePort)
	if (await probe(livePort)) return { url: live, mode: 'live' }
	return { url: fallbackUrl(fallbackPort), mode: 'offline', livePort, fallbackPort, live }
}

async function waitForPort(port, tries = 40) {
	for (let i = 0; i < tries; i++) {
		if (await portOpen(port)) return true
		await sleep(50)
	}
	return false
}

async function main() {
	const livePort = Number(process.env.PI_DASHBOARD_PORT || DEFAULT_PORT)
	const fallbackPort = Number(process.env.PI_DASHBOARD_FALLBACK_PORT || DEFAULT_FALLBACK_PORT)
	const live = dashboardUrl(livePort)
	const args = new Set(process.argv.slice(2))

	if (args.has('--host')) {
		try {
			await serveOffline(live, fallbackPort)
		} catch (error) {
			if (error && error.code === 'EADDRINUSE') return
			throw error
		}
		return
	}

	const target = await resolveDashboardTarget({ livePort, fallbackPort })
	if (target.mode === 'offline' && !(await portOpen(fallbackPort))) {
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--host'], {
			detached: true,
			stdio: 'ignore',
			env: process.env
		})
		child.unref()
		await waitForPort(fallbackPort)
	}
	if (!args.has('--no-open')) openBrowser(target.url)
	console.log(target.url)
}

const invokedDirectly =
	Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (invokedDirectly) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	})
}
