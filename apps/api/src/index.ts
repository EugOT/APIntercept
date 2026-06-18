import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { analyzeDiscovery } from '@interceptor/browser/analysis/discovery';
import {
	autoStartHeadlessBrowser,
	clearTrafficBuffer,
	getActiveBrowser,
	getBrowserHealth,
	getTrafficEntries,
	getTrafficSummary,
	handleBrowserWebSocket,
} from '@interceptor/browser/handler';
import { createDomainProxy } from '@interceptor/browser/handler/api-proxy';
import { getDomain, listDomains } from '@interceptor/browser/handler/domain-loader';
import { connectBrowserRateLimiter } from '@interceptor/browser/remote';
import {
	recordRateLimitedRequest,
	releaseRateLimitSlot,
	validateConfig,
	waitForRateLimitSlot,
} from '@interceptor/shared';
import { type Context, Hono, type Next } from 'hono';
import { cors } from 'hono/cors';
import { WSContext } from 'hono/ws';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import './register-domains.js'; // Side-effect: registers domain plugins

// Connect rate limiter to browserFetch so Chrome-based fetches respect rate limits
connectBrowserRateLimiter({
	wait: waitForRateLimitSlot,
	record: recordRateLimitedRequest,
	release: releaseRateLimitSlot,
});

import { getBridge } from './bridge.js';
import { browserMcp } from './browser-mcp.js';
import { formatStartupBanner } from './format.js';
import {
	CONTROL_TOKEN_HEADER,
	createSecurityConfig,
	isAllowedOrigin,
	isAuthorizedRequest,
	isAuthorizedUpgrade,
	PayloadTooLargeError,
	readRequestBody,
} from './security.js';
import {
	addClient,
	getState,
	removeClient,
	resetState,
	setMultiplier,
	setRunning,
} from './state.js';

const securityConfig = createSecurityConfig();
const config = validateConfig({
	name: 'interceptor-api',
	version: '0.0.1',
	environment: securityConfig.environment,
});
const WS_TICKET_TTL_MS = 60_000;
const wsTickets = new Map<string, number>();

async function requireControlPlaneAuth(c: Context, next: Next) {
	if (isAuthorizedRequest(c.req.raw, securityConfig)) {
		await next();
		return;
	}

	c.header('WWW-Authenticate', 'Bearer');
	return c.json({ error: 'Unauthorized' }, 401);
}

function pruneExpiredWsTickets(now = Date.now()): void {
	for (const [ticket, expiresAt] of wsTickets) {
		if (expiresAt <= now) wsTickets.delete(ticket);
	}
}

function createWsTicket(): { ticket: string; expiresAt: number } {
	const now = Date.now();
	pruneExpiredWsTickets(now);
	const ticket = randomUUID();
	const expiresAt = now + WS_TICKET_TTL_MS;
	wsTickets.set(ticket, expiresAt);
	return { ticket, expiresAt };
}

function consumeWsTicket(ticket: string | null): boolean {
	if (!ticket) return false;
	const expiresAt = wsTickets.get(ticket);
	wsTickets.delete(ticket);
	return expiresAt !== undefined && expiresAt > Date.now();
}

function isAuthorizedWebSocketUpgrade(request: IncomingMessage, requestUrl: URL): boolean {
	return (
		isAuthorizedUpgrade(request, requestUrl, securityConfig) ||
		consumeWsTicket(requestUrl.searchParams.get('ticket'))
	);
}

// Create Hono app for REST routes
const app = new Hono();
app.use(
	'/*',
	cors({
		origin: (origin) => (isAllowedOrigin(origin, securityConfig) ? origin : ''),
		allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization', CONTROL_TOKEN_HEADER],
		exposeHeaders: ['Content-Length'],
		maxAge: 600,
		credentials: false,
	}),
);

// Request timeout middleware — browser navigation can take 60s+, cap at 120s
app.use('/*', async (c, next) => {
	const timeout = setTimeout(() => {
		if (!c.res.headers.get('content-type')) {
			// Response not yet sent — send timeout error
			c.status(504);
			c.res = new Response(JSON.stringify({ error: 'Request timed out after 120s' }), {
				status: 504,
				headers: { 'content-type': 'application/json' },
			});
		}
	}, 120_000);
	try {
		await next();
	} finally {
		clearTimeout(timeout);
	}
});

app.get('/health', (c) => c.json({ status: 'ok' }));

app.use('/browser/*', requireControlPlaneAuth);
app.use('/api', requireControlPlaneAuth);
app.use('/api/*', requireControlPlaneAuth);

// Browser endpoints — traffic capture for API discovery
app.post('/browser/ws-ticket', (c) => {
	const { ticket, expiresAt } = createWsTicket();
	return c.json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
});

app.get('/browser/health', (c) => c.json(getBrowserHealth()));

app.get('/browser/traffic', (c) => {
	const since = c.req.query('since');
	const sinceId = since ? Number.parseInt(since, 10) : undefined;
	return c.json(getTrafficEntries(sinceId));
});

app.get('/browser/traffic/summary', (c) => c.json(getTrafficSummary()));

app.delete('/browser/traffic', (c) => {
	const cleared = clearTrafficBuffer();
	return c.json({ cleared });
});

app.get('/browser/analysis', async (c) => {
	const browser = getActiveBrowser();
	if (!browser) {
		return c.json({ error: 'No active browser — connect via /browser/stream first' }, 503);
	}

	try {
		// Get page HTML and URL from the active browser
		const html = await browser.evaluate(() => document.documentElement.outerHTML);
		const pageUrl = browser.getUrl();

		// Get traffic entries from the capture buffer
		const { entries } = getTrafficEntries();

		const analysis = analyzeDiscovery(html, entries, pageUrl);
		return c.json(analysis);
	} catch (err) {
		return c.json(
			{ error: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

// Browser MCP REST endpoints — used by the MCP server to control the browser
app.route('/browser/mcp', browserMcp);

// Domain API proxy routes — each domain's routes proxy through browserFetch()
// GET /api → list all domains and their routes
app.get('/api', (c) => {
	const domains = listDomains().map((name) => {
		const plugin = getDomain(name);
		return {
			name,
			routeCount: plugin?.routes?.length ?? 0,
			routes: plugin?.routes?.map((r) => `${r.method} /api/${name}${r.path}`) ?? [],
		};
	});
	return c.json({ domains, browserConnected: getActiveBrowser() !== null });
});

// Mount each registered domain's proxy routes at /api/<domainName>/
for (const name of listDomains()) {
	const plugin = getDomain(name);
	if (plugin?.routes && plugin.routes.length > 0) {
		const proxy = createDomainProxy(name, plugin.routes, getActiveBrowser);
		app.route(`/api/${name}`, proxy);
	}
}

// Python bridge REST endpoint — dashboard pages call Python methods via HTTP
app.post('/api/python/:method', async (c) => {
	const method = c.req.param('method');
	try {
		const params = await c.req.json().catch(() => ({}));
		const bridge = await getBridge();
		const result = await bridge.call(method, params);
		return c.json({ result });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

function toFetchHeaders(headers: IncomingMessage['headers']): Headers {
	const normalized = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const item of value) normalized.append(name, item);
		} else if (value !== undefined) {
			normalized.set(name, value);
		}
	}
	return normalized;
}

// Create Node.js HTTP server
const server = createServer(async (req, res) => {
	try {
		const body = await readRequestBody(req, securityConfig.maxHttpBodyBytes);

		const response = await app.fetch(
			new Request(`http://${req.headers.host}${req.url}`, {
				method: req.method,
				headers: toFetchHeaders(req.headers),
				body,
			}),
		);

		res.statusCode = response.status;
		response.headers.forEach((value, key) => {
			res.setHeader(key, value);
		});

		const buffer = await response.arrayBuffer();
		res.end(Buffer.from(buffer));
	} catch (err) {
		if (err instanceof PayloadTooLargeError) {
			res.statusCode = 413;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ error: err.message }));
			return;
		}
		console.error('[api] Request error:', err instanceof Error ? err.message : err);
		res.statusCode = 500;
		res.end(JSON.stringify({ error: 'Internal Server Error' }));
	}
});

// Create WebSocket server
const wss = new WebSocketServer({
	noServer: true,
	maxPayload: securityConfig.wsMaxPayloadBytes,
});

function rejectUpgrade(socket: Socket, status: number, message: string): void {
	socket.write(
		`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`,
	);
	socket.destroy();
}

function createWsRateLimiter() {
	let windowStartedAt = Date.now();
	let count = 0;

	return () => {
		const now = Date.now();
		if (now - windowStartedAt >= 60_000) {
			windowStartedAt = now;
			count = 0;
		}
		count += 1;
		return count <= securityConfig.wsMessagesPerMinute;
	};
}

// WebSocket client adapter for state management
class WSClientAdapter {
	closed = false;
	constructor(private ws: WebSocket) {}

	send(data: string | Buffer): void {
		if (this.closed) return;
		try {
			this.ws.send(data);
		} catch {
			this.closed = true;
		}
	}

	close(code?: number): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.ws.close(code);
		} catch {
			/* ignored */
		}
	}
}

// Handle WebSocket upgrade requests
server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
	const url = req.url || '';
	const requestUrl = new URL(`http://${req.headers.host ?? 'localhost'}${url}`);
	const pathname = requestUrl.pathname;

	try {
		if (pathname !== '/ws' && !pathname.startsWith('/browser/stream')) {
			rejectUpgrade(socket, 404, 'Not Found');
			return;
		}

		if (!isAllowedOrigin(req.headers.origin, securityConfig)) {
			rejectUpgrade(socket, 403, 'Forbidden');
			return;
		}

		if (!isAuthorizedWebSocketUpgrade(req, requestUrl)) {
			rejectUpgrade(socket, 401, 'Unauthorized');
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
			if (pathname === '/ws') {
				const allowMessage = createWsRateLimiter();
				// Dashboard state management WebSocket
				const adapter = new WSClientAdapter(ws);
				const wsContext = new WSContext({
					send: (data, _opts) =>
						adapter.send(
							typeof data === 'string'
								? data
								: Buffer.from(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer)),
						),
					close: (code, reason) => ws.close(code, reason),
					readyState: ws.readyState as 0 | 1 | 2 | 3,
					raw: ws,
				});
				const client = addClient(wsContext);

				ws.on('message', async (data: Buffer) => {
					try {
						if (!allowMessage()) {
							ws.close(1008, 'Rate limit exceeded');
							return;
						}
						const msg = JSON.parse(data.toString());

						if (msg.type === 'compute') {
							// Handle compute messages (Python bridge)
							try {
								const bridge = await getBridge();
								const result = await bridge.call('compute', {
									numbers: msg.numbers,
								});
								adapter.send(
									JSON.stringify({
										type: 'compute:result',
										requestId: msg.requestId,
										data: result,
									}),
								);
							} catch (err) {
								adapter.send(
									JSON.stringify({
										type: 'compute:error',
										requestId: msg.requestId,
										error: err instanceof Error ? err.message : String(err),
									}),
								);
							}
						} else {
							// State management messages
							const state = getState();
							switch (msg.type) {
								case 'increment':
									setMultiplier(state.multiplier + 1);
									break;
								case 'decrement':
									setMultiplier(state.multiplier - 1);
									break;
								case 'set':
									if (typeof msg.value === 'number') {
										setMultiplier(msg.value);
									}
									break;
								case 'pause':
									setRunning(false);
									break;
								case 'play':
									setRunning(true);
									break;
								case 'reset':
									resetState();
									break;
							}
						}
					} catch (err) {
						console.error('WS message error:', err);
					}
				});

				ws.on('close', () => {
					removeClient(client);
				});
			} else if (pathname.startsWith('/browser/stream')) {
				// Browser streaming — launches Patchright, streams frames, captures traffic
				handleBrowserWebSocket(ws, requestUrl).catch((err) => {
					console.error('Browser handler error:', err);
				});
			} else {
				socket.destroy();
			}
		});
	} catch (err) {
		console.error('WebSocket upgrade error:', err);
		socket.destroy();
	}
});

console.log(formatStartupBanner(config));

const port = parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';

let shuttingDown = false;
function shutdown(reason: string, err?: unknown, exitCode = 1): void {
	if (shuttingDown) return;
	shuttingDown = true;

	if (err) console.error(`[FATAL] ${reason}:`, err);
	else console.error(`[shutdown] ${reason}`);

	wss.close();
	server.close(() => {
		process.exit(exitCode);
	});

	setTimeout(() => {
		process.exit(exitCode);
	}, 5_000).unref();
}

process.on('unhandledRejection', (reason) => {
	shutdown('Unhandled rejection', reason);
});
process.on('uncaughtException', (err) => {
	shutdown('Uncaught exception', err);
});
process.on('SIGTERM', () => shutdown('SIGTERM', undefined, 0));
process.on('SIGINT', () => shutdown('SIGINT', undefined, 0));

server.listen(port, host, () => {
	console.log(`Server listening on http://localhost:${port}`);
	// Auto-start a headless browser so domain proxy routes (extractFromPage, browserFetch)
	// work immediately without requiring manual connection via the /browser dashboard.
	// The browser is shared: a subsequent WS connection reuses it (same profile) or
	// replaces it (different profile). Set BROWSER_AUTO_START=false to disable.
	if (process.env.BROWSER_AUTO_START !== 'false') {
		autoStartHeadlessBrowser('generic').catch((err) =>
			console.error('[browser] Auto-start failed:', err),
		);
	}
});
