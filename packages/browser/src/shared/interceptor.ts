/**
 * Generic Request Interceptor Base Class
 *
 * Provides a reusable foundation for domain-specific interceptors.
 * Extend this class and provide InterceptorConfig to capture traffic from any website.
 *
 * @module browser/shared/interceptor
 */

import type { Page, Request, Route } from 'patchright';
import type { InterceptorConfig } from './config.js';
import type { InterceptedRequest, InterceptedResponse, InterceptionCallback } from './types.js';

/**
 * Abstract base class for domain-specific interceptors.
 *
 * Usage:
 * ```typescript
 * class DeckmarketInterceptor extends GenericInterceptor {
 *   constructor() {
 *     super(deckmarketConfig);
 *   }
 * }
 *
 * const interceptor = new DeckmarketInterceptor();
 * await interceptor.attach(page);
 * const headers = await interceptor.waitForHeaders(5000);
 * ```
 */
export abstract class GenericInterceptor {
	protected config: InterceptorConfig;
	protected capturedHeaders: Map<string, string> = new Map();
	protected callbacks: Set<InterceptionCallback> = new Set();
	protected headersPromiseResolve: ((headers: Record<string, string>) => void) | null = null;
	protected isAttached = false;
	protected page: Page | null = null;
	private headersEmitted = false;

	/**
	 * Callback fired when all required headers are captured.
	 * Set before attaching to receive notifications.
	 * Fires only once — subsequent requests after headers are complete do not re-trigger.
	 */
	public onHeadersCaptured: ((headers: Record<string, string>) => void) | null = null;

	constructor(config: InterceptorConfig) {
		this.config = config;
	}

	/**
	 * Get the currently captured headers, if any.
	 * Returns null if not all required headers have been captured.
	 */
	getHeaders(): Record<string, string> | null {
		// Check if we have all required headers
		for (const name of this.config.requiredHeaders) {
			if (!this.capturedHeaders.has(name)) {
				return null;
			}
		}

		const headers: Record<string, string> = {};
		for (const name of this.config.requiredHeaders) {
			const value = this.capturedHeaders.get(name);
			if (value) headers[name] = value;
		}

		// Validate with Zod schema (skip if no schema provided — public APIs with no required headers)
		if (this.config.headerSchema) {
			const result = this.config.headerSchema.safeParse(headers);
			if (!result.success) {
				console.warn(
					`[${this.config.domainName}Interceptor] Invalid headers:`,
					result.error.message,
				);
				return null;
			}
			return result.data as Record<string, string>;
		}

		return headers;
	}

	/**
	 * Check if all required headers have been captured.
	 */
	hasHeaders(): boolean {
		return this.getHeaders() !== null;
	}

	/**
	 * Clear captured headers (e.g., on logout).
	 */
	clearHeaders(): void {
		this.capturedHeaders.clear();
	}

	/**
	 * Register a callback for intercepted request/response pairs.
	 * Returns an unsubscribe function.
	 */
	onIntercept(callback: InterceptionCallback): () => void {
		this.callbacks.add(callback);
		return () => this.callbacks.delete(callback);
	}

	/**
	 * Wait for headers to be captured with timeout.
	 * Returns null if timeout is exceeded.
	 */
	waitForHeaders(timeoutMs: number): Promise<Record<string, string> | null> {
		// If we already have headers, return immediately
		const existing = this.getHeaders();
		if (existing) {
			return Promise.resolve(existing);
		}

		return new Promise((resolve) => {
			// Set up resolver for when headers arrive
			this.headersPromiseResolve = resolve;

			// Set up timeout
			const timeout = setTimeout(() => {
				this.headersPromiseResolve = null;
				resolve(null);
			}, timeoutMs);

			// Check periodically in case headers were captured between checks
			const checkInterval = setInterval(() => {
				const headers = this.getHeaders();
				if (headers) {
					clearTimeout(timeout);
					clearInterval(checkInterval);
					this.headersPromiseResolve = null;
					resolve(headers);
				}
			}, 100);

			// Clean up interval on timeout
			setTimeout(() => clearInterval(checkInterval), timeoutMs);
		});
	}

	/**
	 * Attach the interceptor to a Patchright page.
	 * Sets up route handlers for all configured patterns.
	 */
	async attach(page: Page): Promise<void> {
		if (this.isAttached) {
			return;
		}

		this.page = page;
		this.isAttached = true;

		// Set up route handlers for configured patterns
		for (const pattern of this.config.interceptPatterns) {
			await page.route(pattern, async (route) => {
				await this.handleRoute(route);
			});
		}

		console.log(
			`[${this.config.domainName}Interceptor] Attached (patterns: ${this.config.interceptPatterns.length})`,
		);
	}

	/**
	 * Detach the interceptor from the page.
	 * Removes all route handlers.
	 */
	async detach(): Promise<void> {
		if (!this.isAttached || !this.page) {
			return;
		}

		// Remove all route handlers
		for (const pattern of this.config.interceptPatterns) {
			await this.page.unroute(pattern);
		}

		this.page = null;
		this.isAttached = false;
		console.log(`[${this.config.domainName}Interceptor] Detached from page`);
	}

	/**
	 * Handle an intercepted route.
	 * This is the core interception logic.
	 */
	protected async handleRoute(route: Route): Promise<void> {
		const request = route.request();
		const url = request.url();
		const method = request.method();
		const requestHeaders = request.headers();

		// Capture auth headers from the request
		this.extractHeaders(requestHeaders);

		// Build intercepted request data
		const interceptedRequest: InterceptedRequest = {
			url,
			method,
			headers: requestHeaders,
			body: this.parseRequestBody(request),
			timestamp: Date.now(),
		};

		try {
			// Continue the request and get the response
			const response = await route.fetch();
			const responseHeaders = response.headers();
			const status = response.status();

			// Try to parse response body as JSON
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				// Not JSON, try text
				try {
					body = await response.text();
				} catch {
					body = null;
				}
			}

			const interceptedResponse: InterceptedResponse = {
				url,
				status,
				headers: responseHeaders,
				body,
				timestamp: Date.now(),
			};

			// Notify callbacks
			for (const callback of this.callbacks) {
				callback(interceptedRequest, interceptedResponse);
			}

			// Notify once when headers are first completed (BUG-14 fix)
			if (this.hasHeaders() && this.onHeadersCaptured && !this.headersEmitted) {
				const headers = this.getHeaders();
				if (headers) {
					this.headersEmitted = true;
					this.onHeadersCaptured(headers);
				}
			}

			// Pass through the original response
			await route.fulfill({ response });
		} catch (error) {
			// Let the request fail naturally
			const err = error instanceof Error ? error : new Error(String(error));
			console.error(`[${this.config.domainName}Interceptor] Route handler error:`, err);
			await route.abort('failed');
		}
	}

	/**
	 * Extract required headers from request.
	 * Stores them in capturedHeaders map.
	 */
	protected extractHeaders(requestHeaders: Record<string, string>): void {
		for (const requiredName of this.config.requiredHeaders) {
			// Headers are case-insensitive, but Map keys are case-sensitive
			// Search for the header case-insensitively
			const actualName = Object.keys(requestHeaders).find(
				(key) => key.toLowerCase() === requiredName.toLowerCase(),
			);
			if (actualName) {
				const value = requestHeaders[actualName];
				if (value) {
					this.capturedHeaders.set(requiredName, value);
				}
			}
		}
	}

	/**
	 * Parse request body.
	 * Returns the request body if available, otherwise null.
	 */
	protected parseRequestBody(request: Request): unknown {
		try {
			// Try to get the request body
			const postData = request.postDataBuffer();
			if (postData) {
				try {
					return JSON.parse(postData.toString('utf-8'));
				} catch {
					return postData.toString('utf-8');
				}
			}
		} catch {
			// postDataBuffer() is not always available
		}
		return null;
	}
}
