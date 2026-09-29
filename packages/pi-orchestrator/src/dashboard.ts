import {
	createServer as createHttpServer,
	type ServerResponse,
	type Server as HttpServer
} from 'node:http'
import {
	connect,
	createServer as createNetServer,
	type Server as NetServer,
	type Socket
} from 'node:net'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(homedir(), '.pi-orchestrator')
const assetsRoot = join(homedir(), '.agents/outputs/pi-agent-stack/artifacts/dashboard')
const socketPath = join(root, 'dashboard.sock')
const PORT = Number(process.env.PI_DASHBOARD_PORT || 4317)
const FALLBACK_PORT = Number(process.env.PI_DASHBOARD_FALLBACK_PORT || 4318)
type Session = {
	id: string
	title: string
	cwd: string
	updatedAt: number
	status: string
	model?: string
	events: any[]
	agents: any[]
	edges: any[]
	preview?: string
	currentActivity?: string
}
let host: HttpServer | undefined
let ipcServer: NetServer | undefined
let clients = new Map<string, Socket>()
let sessions = new Map<string, Session>()
let viewers = new Set<ServerResponse>()
let hostStarting: Promise<void> | undefined
/** Live attach handle; agent patches must reuse this socket (a new connect fails if the sock file was unlinked). */
let attachedPublisher: ((data: Partial<Pick<Session, 'agents' | 'edges'>>) => void) | undefined

function httpHostUp(): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect({ host: '127.0.0.1', port: PORT })
		probe.once('connect', () => {
			probe.end()
			resolve(true)
		})
		probe.once('error', () => {
			probe.destroy()
			resolve(false)
		})
	})
}

function publish() {
	const data = JSON.stringify({ type: 'snapshot', sessions: [...sessions.values()] })
	for (const response of viewers) response.write(`data: ${data}\n\n`)
}

function startHost(): Promise<void> {
	if (hostStarting) return hostStarting
	hostStarting = new Promise((resolve, reject) => {
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 })
		} catch (error) {
			reject(error)
			return
		}
		const launch = () => {
			try {
				if (existsSync(socketPath)) unlinkSync(socketPath)
			} catch {}
			const entry = fileURLToPath(import.meta.url)
			const child = spawn('bun', ['run', entry], {
				detached: true,
				stdio: 'ignore',
				env: { ...process.env, PI_DASHBOARD_HOST: '1' }
			})
			child.unref()
			const startedAt = Date.now()
			const wait = setInterval(() => {
				if (existsSync(socketPath)) {
					clearInterval(wait)
					resolve()
					void openDashboardInBrowser(dashboardPublicUrl())
				} else if (Date.now() - startedAt > 3000) {
					clearInterval(wait)
					reject(new Error('Dashboard host failed to start'))
				}
			}, 40)
		}
		const probeOk = () => {
			const probe = connect(socketPath)
			probe.once('connect', () => {
				probe.end()
				resolve()
			})
			probe.once('error', () => {
				probe.destroy()
				void httpHostUp().then((up) => {
					if (up) resolve()
					else launch()
				})
			})
		}
		if (!existsSync(socketPath)) {
			void httpHostUp().then((up) => {
				if (up) resolve()
				else launch()
			})
			return
		}
		probeOk()
		setTimeout(() => {
			hostStarting = undefined
		}, 3100)
	})
	return hostStarting
}

function runHost() {
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 })
	} catch {}
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath)
	} catch {}
	host = createHttpServer((req, res) => {
		res.setHeader('x-content-type-options', 'nosniff')
		res.setHeader('referrer-policy', 'no-referrer')
		res.setHeader(
			'content-security-policy',
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
		)
		if (req.url === '/events') {
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
				'access-control-allow-origin': '*'
			})
			viewers.add(res)
			res.write(
				`data: ${JSON.stringify({ type: 'snapshot', sessions: [...sessions.values()] })}\n\n`
			)
			req.on('close', () => viewers.delete(res))
			return
		}
		const requestPath = (req.url ?? '/').split('?')[0]
		let assetPath: string
		try {
			assetPath = resolve(
				assetsRoot,
				decodeURIComponent(requestPath === '/' ? 'index.html' : requestPath.slice(1))
			)
		} catch {
			res.writeHead(404).end()
			return
		}
		if (!assetPath.startsWith(assetsRoot + sep) || !existsSync(assetPath)) {
			res.writeHead(404).end()
			return
		}
		const contentType = assetPath.endsWith('.html')
			? 'text/html; charset=utf-8'
			: assetPath.endsWith('.js')
				? 'text/javascript; charset=utf-8'
				: assetPath.endsWith('.css')
					? 'text/css; charset=utf-8'
					: 'application/octet-stream'
		res.writeHead(200, {
			'content-type': contentType,
			'cache-control': assetPath.endsWith('.html')
				? 'no-cache'
				: 'public, max-age=31536000, immutable'
		})
		res.end(readFileSync(assetPath))
	})
	host.on('error', () => process.exit(1))
	host.listen(PORT, '127.0.0.1')
	host.on('close', () => {
		try {
			unlinkSync(socketPath)
		} catch {}
	})
	ipcServer = createNetServer((clientSocket) => {
		let buffer = ''
		let attached = false
		clientSocket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString()
			let newline
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline)
				buffer = buffer.slice(newline + 1)
				try {
					const message = JSON.parse(line)
					if (message.type === 'attach') {
						attached = true
						clients.set(message.id, clientSocket)
						sessions.set(message.id, message.session)
					} else if (message.type === 'event') {
						const session = sessions.get(message.id)
						if (!session) continue
						session.updatedAt = Date.now()
						if (message.event.type === 'patch') Object.assign(session, message.event.data)
						else if (message.event.type === 'assistant') session.preview = message.event.text
						else {
							session.events.push(message.event)
							if (session.events.length > 80) session.events.shift()
							if (message.event.type === 'status') session.status = message.event.value
						}
					} else if (message.type === 'detach') {
						sessions.delete(message.id)
						clients.delete(message.id)
					} else if (message.type === 'heartbeat') {
						const session = sessions.get(message.id)
						if (session) session.updatedAt = Date.now()
					}
					publish()
				} catch {}
			}
		})
		clientSocket.on('close', () => {
			if (!attached) return
			for (const [id, client] of clients)
				if (client === clientSocket) {
					clients.delete(id)
					sessions.delete(id)
				}
			publish()
			if (clients.size === 0)
				setTimeout(() => {
					if (clients.size === 0) {
						host?.close()
						ipcServer?.close()
					}
				}, 250)
		})
	})
	ipcServer.on('error', () => process.exit(1))
	ipcServer.listen(socketPath)
}

if (process.env.PI_DASHBOARD_HOST === '1') runHost()

export function dashboardPublicUrl() {
	return `http://127.0.0.1:${PORT}`
}

export function shouldOpenDashboardBrowser(
	env: NodeJS.ProcessEnv = process.env,
	tty: boolean | undefined = process.stdout.isTTY
) {
	if (env.PI_DASHBOARD_OPEN === '0' || env.PI_DASHBOARD_OPEN === 'false') return false
	if (env.PI_SUBAGENT_WORKER === '1') return false
	if (env.PI_DASHBOARD_HOST === '1') return false
	return tty === true
}

export async function fallbackTabIsWatching(
	port = FALLBACK_PORT,
	now = Date.now()
): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/status`, {
			signal: AbortSignal.timeout(400)
		})
		if (!response.ok) return false
		const data = (await response.json()) as { viewers?: number; handoffUntil?: number }
		if ((data.viewers ?? 0) > 0) return true
		return Number(data.handoffUntil) > now
	} catch {
		return false
	}
}

export async function openDashboardInBrowser(
	url: string,
	opts?: {
		env?: NodeJS.ProcessEnv
		tty?: boolean
		platform?: NodeJS.Platform
		spawnFn?: typeof spawn
		hasFallbackTab?: () => Promise<boolean>
	}
) {
	if (!shouldOpenDashboardBrowser(opts?.env ?? process.env, opts?.tty ?? process.stdout.isTTY))
		return
	const hasFallbackTab = opts?.hasFallbackTab ?? fallbackTabIsWatching
	if (await hasFallbackTab()) return
	const platform = opts?.platform ?? process.platform
	const spawnFn = opts?.spawnFn ?? spawn
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

export function attachDashboard(
	session: Pick<Session, 'id' | 'title' | 'cwd'> &
		Partial<Pick<Session, 'model' | 'events' | 'agents' | 'edges' | 'preview' | 'currentActivity'>>,
	onAttach?: (id: string) => void
) {
	let socket: Socket | undefined
	const id = session.id || randomUUID()
	const full = {
		...session,
		id,
		events: session.events ?? [],
		agents: session.agents ?? [],
		edges: session.edges ?? [],
		updatedAt: Date.now(),
		status: 'idle'
	}
	const send = (message: unknown) => {
		if (socket?.writable) socket.write(`${JSON.stringify(message)}\n`)
	}
	const connectToHost = () => {
		socket = connect(socketPath)
		socket.once('connect', () => {
			send({ type: 'attach', id, session: full })
			onAttach?.(id)
		})
		socket.once('error', async () => {
			if (!host) {
				try {
					await startHost()
				} catch {}
			}
			if (!socket?.destroyed) return
			setTimeout(connectToHost, 80)
		})
	}
	connectToHost()
	const heartbeat = setInterval(() => send({ type: 'heartbeat', id }), 10000)
	const update = (data: Partial<Session>) =>
		send({ type: 'event', id, event: { type: 'patch', data } })
	attachedPublisher = (data) => update(data)
	return {
		id,
		event: (type: string, data: unknown) =>
			send({
				type: 'event',
				id,
				event: {
					type,
					...(data && typeof data === 'object' ? data : { value: data }),
					at: Date.now()
				}
			}),
		update,
		close: () => {
			clearInterval(heartbeat)
			if (attachedPublisher) attachedPublisher = undefined
			send({ type: 'detach', id })
			socket?.end()
		},
		url: dashboardPublicUrl()
	}
}

export function publishDashboardAgentUpdate(sessionId: string, agents: any[], edges: any[]) {
	if (attachedPublisher) {
		attachedPublisher({ agents, edges })
		return
	}
	if (!sessionId) return
	const socket = connect(socketPath)
	socket.once('connect', () => {
		socket.write(
			`${JSON.stringify({ type: 'event', id: sessionId, event: { type: 'patch', data: { agents, edges } } })}\n`
		)
		socket.end()
	})
	socket.on('error', () => {})
}
