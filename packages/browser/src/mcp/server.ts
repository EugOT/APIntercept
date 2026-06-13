/// <reference types="node" />
/**
 * Browser MCP Server
 *
 * Registers MCP tools for browser control. Each tool calls the Interceptor API
 * REST endpoints at /browser/mcp/* to interact with the running browser.
 *
 * The browser must be started via the dashboard UI first. Once connected,
 * these tools allow Claude Code to navigate, screenshot, click, type, and
 * interact with the same browser instance the user sees.
 *
 * IMPORTANT: All logging must go to stderr (console.error), never stdout.
 * stdout is reserved for the MCP JSON-RPC protocol.
 *
 * @module browser/mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { z } from 'zod/v3';

const API_BASE = process.env.INTERCEPTOR_API_URL || 'http://localhost:3001';

type ToolFieldSchema = {
	min: (value: number) => ToolFieldSchema;
	max: (value: number) => ToolFieldSchema;
	optional: () => ToolFieldSchema;
	describe: (description: string) => ToolFieldSchema;
};

type ToolShape = Record<string, ToolFieldSchema>;

const zod = z as unknown as {
	object: (shape: ToolShape) => AnySchema;
	string: () => ToolFieldSchema;
	number: () => ToolFieldSchema;
	boolean: () => ToolFieldSchema;
	enum: (values: readonly [string, ...string[]]) => ToolFieldSchema;
};

function toolSchema(shape: ToolShape): AnySchema {
	return zod.object(shape);
}

/** Call a REST endpoint on the Interceptor API */
async function apiCall(path: string, method = 'GET', body?: unknown) {
	const url = `${API_BASE}/browser/mcp${path}`;
	const token = process.env.INTERCEPTOR_CONTROL_TOKEN || process.env.API_AUTH_TOKEN || '';
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token) headers.Authorization = `Bearer ${token}`;

	const options: RequestInit = {
		method,
		headers,
	};
	if (body !== undefined) {
		options.body = JSON.stringify(body);
	}

	let response: Response;
	try {
		response = await fetch(url, options);
	} catch (err) {
		throw new Error(
			`Cannot connect to Interceptor API at ${API_BASE}. Is the API running? (${err instanceof Error ? err.message : String(err)})`,
		);
	}

	if (!response.ok) {
		const text = await response.text();
		let message: string;
		try {
			const json = JSON.parse(text);
			message = json.error || text;
		} catch {
			message = text;
		}
		throw new Error(`API ${method} ${path} failed (${response.status}): ${message}`);
	}

	return response.json();
}

export function createBrowserMcpServer(): McpServer {
	const server = new McpServer({
		name: 'interceptor-browser',
		version: '1.0.0',
	});

	// --- browser_status ---
	server.registerTool(
		'browser_status',
		{
			description:
				'Get the current browser status: running state, current URL, viewport size, uptime. Use this to check if a browser is connected before taking other actions.',
		},
		async () => {
			const result = await apiCall('/status');
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// --- browser_screenshot ---
	server.registerTool(
		'browser_screenshot',
		{
			description:
				'Take a screenshot of the current browser viewport. Returns a JPEG image of what the browser is showing right now. The browser must be connected via the dashboard first.',
			inputSchema: toolSchema({
				quality: zod
					.number()
					.min(1)
					.max(100)
					.optional()
					.describe('JPEG quality 1-100 (default 80). Lower = smaller, higher = sharper.'),
			}),
		},
		async (args: { quality?: number }) => {
			const result = await apiCall('/screenshot', 'POST', {
				quality: args.quality ?? 80,
			});
			return {
				content: [
					{
						type: 'image' as const,
						data: result.data,
						mimeType: result.mimeType,
					},
				],
			};
		},
	);

	// --- browser_navigate ---
	server.registerTool(
		'browser_navigate',
		{
			description:
				'Navigate the browser to a URL. Waits for the page to start loading before returning.',
			inputSchema: toolSchema({
				url: zod.string().describe('The URL to navigate to (e.g., "https://example.com")'),
			}),
		},
		async (args: { url: string }) => {
			const result = await apiCall('/navigate', 'POST', { url: args.url });
			return {
				content: [
					{
						type: 'text' as const,
						text: `Navigated to: ${result.url}`,
					},
				],
			};
		},
	);

	// --- browser_click ---
	server.registerTool(
		'browser_click',
		{
			description:
				'Click at x,y coordinates in the browser viewport (1024x576). Take a screenshot first to see the page and determine click coordinates.',
			inputSchema: toolSchema({
				x: zod.number().describe('X coordinate (0-1024)'),
				y: zod.number().describe('Y coordinate (0-576)'),
				button: zod
					.enum(['left', 'right', 'middle'])
					.optional()
					.describe('Mouse button (default: left)'),
			}),
		},
		async (args: { x: number; y: number; button?: 'left' | 'right' | 'middle' }) => {
			await apiCall('/click', 'POST', {
				x: args.x,
				y: args.y,
				button: args.button ?? 'left',
			});
			return {
				content: [
					{
						type: 'text' as const,
						text: `Clicked at (${args.x}, ${args.y}) with ${args.button ?? 'left'} button`,
					},
				],
			};
		},
	);

	// --- browser_type ---
	server.registerTool(
		'browser_type',
		{
			description:
				'Type text into the currently focused element in the browser. Click on an input field first to focus it.',
			inputSchema: toolSchema({
				text: zod.string().describe('The text to type'),
			}),
		},
		async (args: { text: string }) => {
			await apiCall('/type', 'POST', { text: args.text });
			return {
				content: [
					{
						type: 'text' as const,
						text: `Typed: "${args.text}"`,
					},
				],
			};
		},
	);

	// --- browser_scroll ---
	server.registerTool(
		'browser_scroll',
		{
			description: 'Scroll the browser page. Positive deltaY scrolls down, negative scrolls up.',
			inputSchema: toolSchema({
				x: zod.number().describe('X coordinate to scroll at (0-1024)'),
				y: zod.number().describe('Y coordinate to scroll at (0-576)'),
				deltaX: zod.number().optional().describe('Horizontal scroll pixels (default 0)'),
				deltaY: zod
					.number()
					.optional()
					.describe('Vertical scroll pixels (positive=down, default 300)'),
			}),
		},
		async (args: { x: number; y: number; deltaX?: number; deltaY?: number }) => {
			await apiCall('/scroll', 'POST', {
				x: args.x,
				y: args.y,
				deltaX: args.deltaX ?? 0,
				deltaY: args.deltaY ?? 300,
			});
			return {
				content: [
					{
						type: 'text' as const,
						text: `Scrolled at (${args.x}, ${args.y}) by (${args.deltaX ?? 0}, ${args.deltaY ?? 300})`,
					},
				],
			};
		},
	);

	// --- browser_key ---
	server.registerTool(
		'browser_key',
		{
			description:
				'Press a keyboard key (Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, etc.)',
			inputSchema: toolSchema({
				key: zod
					.string()
					.describe(
						'Key name: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown',
					),
			}),
		},
		async (args: { key: string }) => {
			await apiCall('/key', 'POST', { key: args.key });
			return {
				content: [
					{
						type: 'text' as const,
						text: `Pressed key: ${args.key}`,
					},
				],
			};
		},
	);

	// --- browser_evaluate ---
	server.registerTool(
		'browser_evaluate',
		{
			description:
				'Execute JavaScript in the browser page context. Returns the result. Useful for reading page content, checking element states, or extracting data.',
			inputSchema: toolSchema({
				script: zod
					.string()
					.describe(
						'JavaScript to evaluate in the page (e.g., "document.title" or "document.querySelector(\'h1\').textContent")',
					),
			}),
		},
		async (args: { script: string }) => {
			const result = await apiCall('/evaluate', 'POST', { script: args.script });
			return {
				content: [
					{
						type: 'text' as const,
						text:
							typeof result.result === 'string'
								? result.result
								: JSON.stringify(result.result, null, 2),
					},
				],
			};
		},
	);

	// --- browser_traffic ---
	server.registerTool(
		'browser_traffic',
		{
			description:
				'Get intercepted API traffic (requests + responses) captured via Chrome DevTools Protocol (CDP) route interception. Returns all HTTP requests and responses made by the browser. Use this after navigating to analyze what API endpoints the web frontend is calling and extract headers/tokens.',
			inputSchema: toolSchema({
				since: zod
					.number()
					.optional()
					.describe(
						'Only return entries after this Unix timestamp (ms). Omit to get all buffered traffic.',
					),
				clear: zod
					.boolean()
					.optional()
					.describe('Set to true to clear the traffic buffer after reading'),
			}),
		},
		async (args: { since?: number; clear?: boolean }) => {
			const params = args.since ? `?since=${args.since}` : '';
			const result = await apiCall(`/traffic${params}`);

			if (args.clear) {
				await apiCall('/traffic/clear', 'POST');
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// --- browser_traffic_clear ---
	server.registerTool(
		'browser_traffic_clear',
		{
			description:
				"Clear the intercepted traffic buffer. Use this before navigating to a new page to get a clean capture of only that page's API calls.",
		},
		async () => {
			await apiCall('/traffic/clear', 'POST');
			return {
				content: [
					{
						type: 'text' as const,
						text: 'Traffic buffer cleared',
					},
				],
			};
		},
	);

	return server;
}
