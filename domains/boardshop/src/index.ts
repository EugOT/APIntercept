/**
 * BoardShop Domain Plugin (Reference Example)
 *
 * Demonstrates the complete DomainPlugin interface with:
 * - Interceptor factory (createInterceptor)
 * - Credential verification via API client (verifyCredentials)
 * - Login page detection (detectLoginPage)
 * - WebSocket event handlers (onVerified, onVerificationFailed, onLoginDetected)
 * - Route registration (routes array)
 *
 * PATTERN: The plugin is the glue between the interceptor (captures headers),
 * the API client (verifies them), the session manager (stores them),
 * and the routes (uses them to serve data).
 *
 * @module domain-boardshop/index
 */

import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import { verifyCredentials } from './api-client.js';
import { boardShopInterceptorConfig } from './config.js';
import { BoardShopInterceptor } from './interceptor.js';
import { routes } from './routes.js';
import { BoardShopSessionManager } from './session-manager.js';

export const plugin: DomainPlugin = {
	domainName: 'boardshop',
	config: boardShopInterceptorConfig,
	routes,
	createInterceptor: () => new BoardShopInterceptor(),

	// PATTERN: detectLoginPage uses URL matching — simple string check is enough.
	detectLoginPage: (url: string) => url.includes('boardshop.example.com/login'),

	// PATTERN: verifyCredentials makes a real API call to confirm captured headers work.
	// On success, store the account info in the session manager.
	// On failure, the browser handler emits onVerificationFailed so the UI can show an error.
	async verifyCredentials(headers) {
		const result = await verifyCredentials(
			headers as Record<string, string> & { Authorization: string; 'X-Shop-Session': string },
		);
		if (result.valid && result.accountId) {
			const manager = BoardShopSessionManager.getInstance();
			manager.markVerified('boardshop', result.accountId);
		}
		return {
			valid: result.valid,
			accountNumber: result.accountId,
			displayName: result.displayName,
			error: result.error,
		};
	},

	// PATTERN: WebSocket event payloads — the browser handler sends these to connected clients.
	// The dashboard UI uses these to show connection status badges.
	onVerified: (result) => ({
		type: 'boardshop_verified',
		accountId: result.accountNumber,
		displayName: result.displayName,
	}),
	onVerificationFailed: (error) => ({ type: 'boardshop_verification_failed', error }),
	onLoginDetected: () => ({ type: 'boardshop_login_detected' }),
};

export { boardShopInterceptorConfig } from './config.js';
export { BoardShopInterceptor } from './interceptor.js';
export { routes } from './routes.js';
export { BoardShopSessionManager } from './session-manager.js';
