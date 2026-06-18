/**
 * Generic Authentication Service Base Class
 *
 * Provides a reusable foundation for domain-specific authentication flows.
 * Extend this class to handle login and session management for any website.
 *
 * @module browser/shared/auth
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'patchright';
import { chromium } from 'patchright';
import { BlockerManager } from '../blocker.js';
import type { GenericInterceptor } from './interceptor.js';

/**
 * Authentication state discriminated union.
 */
export type AuthState =
	| { status: 'disconnected' }
	| { status: 'connecting' }
	| { status: 'needs-login'; sessionId: string }
	| { status: 'connected'; headers: Record<string, string>; accountNumber?: string }
	| { status: 'error'; message: string };

/**
 * Configuration for auth service.
 */
export interface AuthConfig {
	/** Profile name for persistent storage (e.g., 'boardshop-main', 'deckmarket-profile') */
	profileName?: string;
	/** Whether to run headless (default: false) */
	headless?: boolean;
	/** Viewport width (default: 1280) */
	viewportWidth?: number;
	/** Viewport height (default: 800) */
	viewportHeight?: number;
	/** Enable ad blocking (default: true) */
	enableAdBlocking?: boolean;
	/** CSS selector to extract account identifier from page */
	accountSelector?: string;
	/** Account/dashboard page URL */
	accountUrl?: string;
}

/**
 * Abstract base class for domain-specific authentication services.
 *
 * Usage:
 * ```typescript
 * class DeckmarketAuthService extends GenericAuthService {
 *   constructor(config: AuthConfig) {
 *     super(config);
 *   }
 *
 *   protected createInterceptor(): GenericInterceptor {
 *     return new DeckmarketInterceptor(deckmarketConfig);
 *   }
 *
 *   protected getLoginUrl(): string {
 *     return 'https://deckmarket.com/login';
 *   }
 * }
 * ```
 */
export abstract class GenericAuthService {
	protected config: AuthConfig;
	protected context: BrowserContext | null = null;
	protected page: Page | null = null;
	protected interceptor: GenericInterceptor | null = null;
	protected state: AuthState = { status: 'disconnected' };
	protected sessionId: string;

	constructor(config: AuthConfig) {
		this.config = {
			profileName: 'default-profile',
			headless: false,
			viewportWidth: 1280,
			viewportHeight: 800,
			enableAdBlocking: true,
			...config,
		} as Required<AuthConfig>;
		this.sessionId = crypto.randomUUID();
	}

	/**
	 * Get the current session ID.
	 */
	getSessionId(): string {
		return this.sessionId;
	}

	/**
	 * Get the current authentication state.
	 */
	getState(): AuthState {
		return this.state;
	}

	/**
	 * Get captured headers if authenticated.
	 */
	getCapturedHeaders(): Record<string, string> | null {
		return this.interceptor?.getHeaders() ?? null;
	}

	/**
	 * Get the browser page (for embedding or visual inspection).
	 */
	getPage(): Page | null {
		return this.page;
	}

	/**
	 * Create the interceptor for this domain.
	 * Subclasses must implement this.
	 */
	protected abstract createInterceptor(): GenericInterceptor;

	/**
	 * Get the profiles directory.
	 */
	protected getProfilesDir(): string {
		const envDir = process.env.BROWSER_PROFILES_DIR;
		if (envDir) {
			return envDir;
		}
		return join(process.cwd(), 'data', 'browser-profiles');
	}

	/**
	 * Get or create a profile path.
	 */
	protected getOrCreateProfilePath(profileName: string): string {
		const profilesDir = this.getProfilesDir();
		const profilePath = join(profilesDir, profileName);

		if (!existsSync(profilePath)) {
			mkdirSync(profilePath, { recursive: true });
			console.log(
				`[${this.config.profileName || 'default'}Auth] Created profile directory: ${profilePath}`,
			);
		}

		return profilePath;
	}

	/**
	 * Start or resume an authentication session.
	 */
	async startSession(): Promise<AuthState> {
		if (this.context) {
			console.log(`[${this.config.profileName || 'default'}Auth] Session already started`);
			return this.state;
		}

		this.state = { status: 'connecting' };

		try {
			// Get profile path for persistent context
			const profileName = this.config.profileName || 'default-profile';
			const profilePath = this.getOrCreateProfilePath(profileName);
			console.log(`[${profileName}Auth] Using profile: ${profilePath}`);

			// Launch persistent context
			const executablePath = process.env.CHROMIUM_PATH || undefined;
			this.context = await chromium.launchPersistentContext(profilePath, {
				executablePath,
				headless: this.config.headless || false,
				viewport: {
					width: this.config.viewportWidth || 1280,
					height: this.config.viewportHeight || 800,
				},
				args: ['--disable-infobars', '--disable-blink-features=AutomationControlled'],
			});

			// Get or create page
			const pages = this.context.pages();
			this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

			// Enable ad blocking
			if (this.config.enableAdBlocking) {
				const blocker = BlockerManager.getInstance();
				await blocker.enableBlockingSilent(this.page);
			}

			// Create and attach interceptor
			this.interceptor = this.createInterceptor();
			await this.interceptor.attach(this.page);

			// Run domain-specific session startup
			const startupState = await this.onSessionStart();
			this.state = startupState;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			this.state = { status: 'error', message };
			console.error(`[${this.config.profileName || 'default'}Auth] Error starting session:`, error);
		}

		return this.state;
	}

	/**
	 * Check authentication status and wait for headers if needed.
	 */
	async checkAuth(timeoutMs = 5000): Promise<AuthState> {
		if (!this.interceptor) {
			return { status: 'error', message: 'No active session' };
		}

		const headers = await this.interceptor.waitForHeaders(timeoutMs);

		if (headers) {
			const accountNumber = await this.extractAccountNumber();
			this.state = {
				status: 'connected',
				headers,
				accountNumber,
			};
		}

		return this.state;
	}

	/**
	 * Navigate to a specific URL.
	 */
	async navigate(url: string): Promise<void> {
		if (!this.page) {
			throw new Error('No active session');
		}
		await this.page.goto(url, { waitUntil: 'domcontentloaded' });
	}

	/**
	 * Extract account identifier from the page.
	 * Override in subclasses for domain-specific logic.
	 */
	protected async extractAccountNumber(): Promise<string | undefined> {
		if (!this.page) return undefined;

		try {
			const selector = this.config.accountSelector;
			if (!selector) return undefined;

			const accountNumber = await this.page.evaluate((sel: string) => {
				const element = document.querySelector(sel);
				if (element) {
					return element.textContent?.trim() || undefined;
				}
				return undefined;
			}, selector);

			return accountNumber;
		} catch {
			return undefined;
		}
	}

	/**
	 * Disconnect and clean up the session.
	 */
	async disconnect(): Promise<void> {
		console.log(`[${this.config.profileName || 'default'}Auth] Disconnecting...`);

		if (this.interceptor) {
			await this.interceptor.detach();
			this.interceptor = null;
		}

		if (this.context) {
			await this.context.close();
			this.context = null;
		}

		this.page = null;
		this.state = { status: 'disconnected' };
		console.log(`[${this.config.profileName || 'default'}Auth] Disconnected`);
	}

	/**
	 * Clear cookies and storage (logout).
	 */
	async clearSession(): Promise<void> {
		if (!this.context) return;

		console.log(`[${this.config.profileName || 'default'}Auth] Clearing session data...`);
		await this.context.clearCookies();

		if (this.interceptor) {
			this.interceptor.clearHeaders();
		}

		this.state = { status: 'disconnected' };
		console.log(`[${this.config.profileName || 'default'}Auth] Session cleared`);
	}

	/**
	 * Hook: Called when session starts.
	 * Subclasses override to implement domain-specific startup logic.
	 * Default: Navigate to account page and wait for headers.
	 */
	protected async onSessionStart(): Promise<AuthState> {
		if (!this.page || !this.interceptor) {
			return { status: 'error', message: 'No page or interceptor' };
		}

		// If no account URL configured, just wait for headers from wherever user navigates
		if (!this.config.accountUrl) {
			// Wait for user to navigate manually
			this.state = { status: 'needs-login', sessionId: this.sessionId };
			return this.state;
		}

		console.log(`[${this.config.profileName || 'default'}Auth] Navigating to account page...`);
		await this.page.goto(this.config.accountUrl, { waitUntil: 'domcontentloaded' });

		// Wait a moment for any redirects
		await this.page.waitForTimeout(2000);

		// Check current URL
		const currentUrl = this.page.url();
		console.log(`[${this.config.profileName || 'default'}Auth] Current URL: ${currentUrl}`);

		// Try to capture headers
		const headers = await this.interceptor.waitForHeaders(5000);

		if (headers) {
			const accountNumber = await this.extractAccountNumber();
			return {
				status: 'connected',
				headers,
				accountNumber: accountNumber || 'Unknown',
			};
		}

		// No headers yet, user needs to log in
		return { status: 'needs-login', sessionId: this.sessionId };
	}
}
