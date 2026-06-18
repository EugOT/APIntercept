/**
 * BoardShop Request Interceptor (Reference Example)
 *
 * Demonstrates the error-handling override pattern: catch "page closed" errors
 * that occur during browser cleanup and continue gracefully instead of crashing.
 *
 * PATTERN: Override handleRoute() to wrap super.handleRoute() in a try/catch.
 * This prevents browser cleanup from throwing unhandled errors that break
 * subsequent requests.
 *
 * @module domain-boardshop/interceptor
 */

import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import type { Route } from 'patchright';
import { boardShopInterceptorConfig } from './config.js';
import type { BoardShopHeaders } from './types.js';

export class BoardShopInterceptor extends GenericInterceptor {
	constructor() {
		super(boardShopInterceptorConfig);
	}

	/**
	 * PATTERN: Override handleRoute for graceful error handling.
	 * "Target page closed" is expected during browser cleanup — not an error.
	 */
	protected async handleRoute(route: Route): Promise<void> {
		try {
			await super.handleRoute(route);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes('Target page, context or browser has been closed')) {
				return; // Expected during cleanup — silently ignore
			}
			console.error('[BoardShopInterceptor] Route handling error:', error);
			try {
				await route.continue();
			} catch {
				// Route may already be closed
			}
		}
	}

	/** Convenience: get headers as the domain-specific type */
	getBoardShopHeaders(): BoardShopHeaders | null {
		return this.getHeaders() as BoardShopHeaders | null;
	}
}
