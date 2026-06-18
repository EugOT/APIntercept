/**
 * Blocker Manager
 *
 * Singleton manager for the Ghostery adblocker.
 * Provides a shared blocker instance across all pages with disk caching.
 *
 * @module browser
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fullLists, PlaywrightBlocker, type Request } from '@ghostery/adblocker-playwright';
import fetch from 'cross-fetch';
import type { Page } from 'patchright';
import { type BrowserConfig, getBrowserConfig } from './config.js';

// =============================================================================
// Types
// =============================================================================

interface BlockerStats {
	blockedRequests: number;
	redirectedRequests: number;
}

// =============================================================================
// BlockerManager
// =============================================================================

/**
 * Blocker manager singleton.
 *
 * Manages a shared Ghostery adblocker instance for all browser pages.
 * Features:
 * - Lazy initialization on first use
 * - Disk caching of filter engine for fast startup
 * - Shared across all pages to reduce memory
 * - Request blocking statistics
 *
 * @example
 * ```typescript
 * const blockerManager = BlockerManager.getInstance();
 *
 * // Enable blocking on a page
 * const page = await pool.acquirePage();
 * await blockerManager.enableBlocking(page);
 *
 * // Navigate and blocking happens automatically
 * await page.goto('https://example.com');
 *
 * // Check stats
 * const stats = blockerManager.getStats();
 * console.log(`Blocked ${stats.blockedRequests} requests`);
 * ```
 */
export class BlockerManager {
	private static instance: BlockerManager | null = null;

	private readonly config: BrowserConfig;
	private readonly cachePath: string;
	private blocker: PlaywrightBlocker | null = null;
	private initPromise: Promise<PlaywrightBlocker> | null = null;
	private stats: BlockerStats = { blockedRequests: 0, redirectedRequests: 0 };
	private listenersAttached = false;

	private constructor(config?: BrowserConfig) {
		this.config = config ?? getBrowserConfig();
		this.cachePath = join(this.config.cacheDir, 'adblocker-engine.bin');
	}

	/**
	 * Get the singleton instance.
	 */
	static getInstance(config?: BrowserConfig): BlockerManager {
		if (!BlockerManager.instance) {
			BlockerManager.instance = new BlockerManager(config);
		}
		return BlockerManager.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		BlockerManager.instance = null;
	}

	// =========================================================================
	// Initialization
	// =========================================================================

	/**
	 * Get the blocker instance, initializing if needed.
	 */
	async getBlocker(): Promise<PlaywrightBlocker> {
		if (this.blocker) {
			return this.blocker;
		}

		// Avoid concurrent initialization
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this.initialize();
		this.blocker = await this.initPromise;
		this.initPromise = null;

		return this.blocker;
	}

	/**
	 * Initialize the blocker with filter lists.
	 * Times out after 30 seconds.
	 */
	private async initialize(): Promise<PlaywrightBlocker> {
		// Ensure cache directory exists
		await fs.mkdir(this.config.cacheDir, { recursive: true });

		const INIT_TIMEOUT_MS = 30_000;
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(`BlockerManager.initialize timed out after ${INIT_TIMEOUT_MS}ms`)),
				INIT_TIMEOUT_MS,
			),
		);

		const blockerPromise = PlaywrightBlocker.fromLists(
			fetch,
			fullLists,
			{ enableCompression: true },
			{
				path: this.cachePath,
				read: fs.readFile,
				write: fs.writeFile,
			},
		);

		const blocker = await Promise.race([blockerPromise, timeoutPromise]);
		return blocker;
	}

	// =========================================================================
	// Page Blocking
	// =========================================================================

	/**
	 * Enable blocking on a page.
	 *
	 * Must be called before navigating to enable network-level blocking.
	 * Also sets up event handlers for statistics tracking.
	 *
	 * @param page - The Patchright page to enable blocking on
	 */
	async enableBlocking(page: Page): Promise<void> {
		const blocker = await this.getBlocker();

		// Cast required: Patchright's Page type is runtime-compatible with Playwright
		// but the type definitions differ. The Ghostery library expects Playwright.Page.
		// biome-ignore lint/suspicious/noExplicitAny: Patchright Page is runtime-compatible with Playwright Page
		await blocker.enableBlockingInPage(page as any);

		// Track blocked requests — attach listeners only once (BUG-31 fix)
		if (!this.listenersAttached) {
			this.listenersAttached = true;
			blocker.on('request-blocked', (request: Request) => {
				this.stats.blockedRequests++;
				console.log('[Blocked]', request.url.substring(0, 80));
			});

			blocker.on('request-redirected', (request: Request) => {
				this.stats.redirectedRequests++;
				console.log('[Redirected]', request.url.substring(0, 80));
			});
		}
	}

	/**
	 * Enable blocking on a page with silent logging.
	 * Same as enableBlocking but doesn't log each blocked request.
	 *
	 * NOTE: Does NOT add event listeners to avoid memory leaks when
	 * called repeatedly across multiple pages.
	 * Times out after 10 seconds.
	 */
	async enableBlockingSilent(page: Page): Promise<void> {
		const blocker = await this.getBlocker();

		const ENABLE_TIMEOUT_MS = 10_000;
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(`enableBlockingInPage timed out after ${ENABLE_TIMEOUT_MS}ms`)),
				ENABLE_TIMEOUT_MS,
			),
		);

		// biome-ignore lint/suspicious/noExplicitAny: Patchright Page is runtime-compatible with Playwright Page
		await Promise.race([blocker.enableBlockingInPage(page as any), timeoutPromise]);

		// NOTE: We intentionally don't add event listeners here.
		// Adding listeners on a shared singleton causes memory leaks
		// as listeners accumulate with each page.
	}

	// =========================================================================
	// Statistics
	// =========================================================================

	/**
	 * Get blocking statistics.
	 */
	getStats(): BlockerStats {
		return { ...this.stats };
	}

	/**
	 * Reset blocking statistics.
	 */
	resetStats(): void {
		this.stats = { blockedRequests: 0, redirectedRequests: 0 };
	}

	/**
	 * Check if the blocker is initialized.
	 */
	isInitialized(): boolean {
		return this.blocker !== null;
	}
}

// =============================================================================
// Convenience Exports
// =============================================================================

/**
 * Get the blocker manager instance.
 */
export function getBlockerManager(): BlockerManager {
	return BlockerManager.getInstance();
}
