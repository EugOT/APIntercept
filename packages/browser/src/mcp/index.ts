#!/usr/bin/env bun
/**
 * Browser MCP Server Entry Point
 *
 * Run via: bun packages/browser/src/mcp/index.ts
 *
 * This process communicates with Claude Code via stdio (JSON-RPC).
 * NEVER log to stdout — use console.error for all diagnostics.
 *
 * @module browser/mcp
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrowserMcpServer } from './server';

async function main() {
	const apiUrl = process.env.INTERCEPTOR_API_URL || 'http://localhost:3001';
	console.error(`[browser-mcp] Starting MCP server (API: ${apiUrl})...`);

	const server = createBrowserMcpServer();
	const transport = new StdioServerTransport();

	await server.connect(transport);

	console.error('[browser-mcp] MCP server connected via stdio');
}

main().catch((err) => {
	console.error('[browser-mcp] Fatal error:', err);
	process.exit(1);
});
