/**
 * API Client Code Generator
 *
 * Generates TypeScript API client code from analyzed traffic patterns.
 * Produces a complete, type-safe client class with Zod validation.
 *
 * @module browser/codegen/client-codegen
 */

import type { EndpointPattern } from './traffic-analyzer';

/**
 * Configuration for client generation.
 */
export interface ClientGenerationConfig {
	/** Domain name (e.g., 'boardshop', 'deckmarket') */
	domainName: string;

	/** Class name for generated client (e.g., 'BoardshopApiClient') */
	className: string;

	/** Base URLs (e.g., ['https://api.boardshop.com', 'https://cdn.boardshop.com']) */
	baseUrls: string[];

	/** Required header names for authentication */
	requiredHeaders: string[];

	/** Endpoint patterns to generate methods for */
	endpoints: EndpointPattern[];

	/** Optional: custom header setup code */
	headerSetupCode?: string;
}

/**
 * Extract the path portion from a URL pattern (strips protocol + host).
 * Examples:
 * - https://www.example-marketplace.com/api/config/menu → /api/config/menu
 * - /accounts/{id}/positions → /accounts/{id}/positions
 */
function extractPath(pattern: string): string {
	try {
		const url = new URL(pattern);
		return url.pathname;
	} catch {
		return pattern; // Already a relative path
	}
}

/**
 * Extract the base URL (protocol + host) from a full URL pattern.
 * Returns empty string if pattern is already relative.
 */
function extractBaseUrl(pattern: string): string {
	try {
		const url = new URL(pattern);
		return url.origin;
	} catch {
		return '';
	}
}

/**
 * Convert URL pattern to TypeScript method name.
 * Examples:
 * - /accounts/{id}/positions → getAccountPositions
 * - /api/config/menu → getApiConfigMenu
 * - https://promoted.example-marketplace.com/browse-category → getBrowseCategory
 * - POST /orders → createOrder
 */
function patternToMethodName(method: string, pattern: string): string {
	const path = extractPath(pattern);
	const parts = path
		.split('/')
		.filter((p) => p && p !== '{id}')
		.map((p) =>
			p
				.replace(/[^a-zA-Z0-9]/g, '_')
				.split('_')
				.filter(Boolean)
				.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
				.join(''),
		);

	const verb =
		method === 'GET'
			? 'get'
			: method === 'POST'
				? 'create'
				: method === 'PUT'
					? 'update'
					: method === 'DELETE'
						? 'delete'
						: 'execute';

	return verb + parts.join('');
}

/**
 * Extract URL parameters from pattern.
 * Example: /accounts/{id}/positions/{orderId} → ['id', 'orderId']
 */
function extractUrlParams(pattern: string): string[] {
	const matches = pattern.match(/\{(\w+)\}/g) || [];
	return matches.map((m) => m.slice(1, -1));
}

/**
 * Generate TypeScript method code for an endpoint.
 */
function generateEndpointMethod(pattern: EndpointPattern): string {
	const methodName = patternToMethodName(pattern.method, pattern.pattern);
	const path = extractPath(pattern.pattern);
	const urlParams = extractUrlParams(path);

	// Build parameter list
	const params = [...urlParams, 'options?: { timeout?: number }'];
	const paramList = params.join(', ');

	// Build URL — use the full URL from the pattern if it's absolute, otherwise use baseUrl + path
	const isAbsolute = pattern.pattern.startsWith('http');
	const baseForUrl = isAbsolute ? extractBaseUrl(pattern.pattern) : pattern.baseUrl;
	let urlCode = `\`${baseForUrl}${path}\``;
	if (urlParams.length > 0) {
		const replacements = urlParams.map((p) => `.replace('{${p}}', String(${p}))`).join('');
		urlCode = `\`${baseForUrl}${path}\`${replacements}`;
	}

	const fullUrl = isAbsolute ? pattern.pattern : `${pattern.baseUrl}${path}`;
	return `
	/**
	 * ${pattern.method} ${fullUrl}
	 */
	async ${methodName}(${paramList}): Promise<unknown> {
		const url = ${urlCode};
		const response = await fetch(url, {
			method: '${pattern.method}',
			headers: this.headers,
			timeout: options?.timeout,
		});

		if (!response.ok) {
			throw new Error(\`${pattern.method} \${url} failed with status \${response.status}\`);
		}

		try {
			return await response.json();
		} catch {
			return null;
		}
	}
`;
}

/**
 * Generate the complete API client class.
 */
export function generateClientClass(config: ClientGenerationConfig): string {
	const methods = config.endpoints
		.filter((ep) => ep.canInferSchema)
		.map((ep) => generateEndpointMethod(ep))
		.join('\n');

	const headerSetup = config.headerSetupCode || `this.headers = headers; // Store for each request`;

	return `
/**
 * Auto-generated API client for ${config.domainName}
 *
 * This client was generated from captured traffic.
 * Each method corresponds to an observed API endpoint.
 */
export class ${config.className} {
	private headers: Record<string, string>;

	constructor(headers: Record<string, string>) {
		${headerSetup}
	}

	/**
	 * Set or update authentication headers.
	 */
	setHeaders(headers: Record<string, string>): void {
		this.headers = { ...this.headers, ...headers };
	}

	/**
	 * Get current headers.
	 */
	getHeaders(): Record<string, string> {
		return { ...this.headers };
	}
${methods}
}
`;
}

/**
 * Generate the complete TypeScript file with imports and exports.
 */
export function generateClientFile(config: ClientGenerationConfig): string {
	const clientClass = generateClientClass(config);

	return `/**
 * Auto-generated API client for ${config.domainName}
 *
 * Generated from captured traffic analysis.
 * Base URLs: ${config.baseUrls.join(', ')}
 * Required Headers: ${config.requiredHeaders.join(', ')}
 * Total Endpoints: ${config.endpoints.length}
 * Endpoints with Schema: ${config.endpoints.filter((ep) => ep.canInferSchema).length}
 *
 * To regenerate: bun run --filter @interceptor/browser codegen ${config.domainName}
 */

/**
 * Create a new API client instance.
 *
 * @param headers Authentication headers (e.g., { Authorization: 'Bearer token' })
 * @returns API client instance
 */
export function create${config.className.replace(/Client$/, '')}(headers: Record<string, string>): ${config.className} {
	return new ${config.className}(headers);
}

${clientClass}
`;
}
