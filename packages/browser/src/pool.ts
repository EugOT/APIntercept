/**
 * Browser Pool
 *
 * Singleton pool managing browser instances and tabs for web scraping.
 * Provides lazy initialization, tab reuse, idle timeout, and graceful shutdown.
 *
 * @module browser
 */

import type { Browser, BrowserContext, Page } from 'patchright';
import { chromium } from 'patchright';
import { type BrowserConfig, getBrowserConfig } from './config.js';

// =============================================================================
// Types
// =============================================================================

interface PooledPage {
	page: Page;
	inUse: boolean;
	lastUsed: number;
}

interface PoolState {
	browser: Browser | null;
	context: BrowserContext | null;
	pages: Map<string, PooledPage>;
	isShuttingDown: boolean;
}

// =============================================================================
// BrowserPool
// =============================================================================

/**
 * Browser pool singleton.
 *
 * Manages a single browser instance with multiple tabs for concurrent scraping.
 * Features:
 * - Lazy browser launch on first `acquirePage()`
 * - Tab reuse to avoid browser restarts
 * - Configurable max concurrent tabs
 * - Idle timeout to close browser after inactivity
 * - Graceful shutdown with cleanup
 *
 * @example
 * ```typescript
 * const pool = BrowserPool.getInstance();
 *
 * // Acquire a page for scraping
 * const page = await pool.acquirePage();
 * try {
 *   await page.goto('https://example.com');
 *   // ... scrape content
 * } finally {
 *   // Always release the page back to the pool
 *   pool.releasePage(page);
 * }
 *
 * // Graceful shutdown
 * await pool.shutdown();
 * ```
 */
export class BrowserPool {
	private static instance: BrowserPool | null = null;

	private readonly config: BrowserConfig;
	private readonly state: PoolState;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private initPromise: Promise<void> | null = null;

	private constructor(config?: BrowserConfig) {
		this.config = config ?? getBrowserConfig();
		this.state = {
			browser: null,
			context: null,
			pages: new Map(),
			isShuttingDown: false,
		};
	}

	/**
	 * Get the singleton instance.
	 */
	static getInstance(config?: BrowserConfig): BrowserPool {
		if (!BrowserPool.instance) {
			BrowserPool.instance = new BrowserPool(config);
		}
		return BrowserPool.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static async resetInstance(): Promise<void> {
		if (BrowserPool.instance) {
			await BrowserPool.instance.shutdown();
			BrowserPool.instance = null;
		}
	}

	// =========================================================================
	// Initialization
	// =========================================================================

	/**
	 * Lazily initialize the browser on first use.
	 */
	private async ensureInitialized(): Promise<void> {
		if (this.state.browser && this.state.context) {
			return;
		}

		// Avoid concurrent initialization
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this.initialize();
		await this.initPromise;
		this.initPromise = null;
	}

	/**
	 * Initialize browser and context.
	 */
	private async initialize(): Promise<void> {
		if (this.state.isShuttingDown) {
			throw new Error('BrowserPool is shutting down');
		}

		console.log('[BrowserPool] Launching browser...');

		this.state.browser = await chromium.launch({
			headless: this.config.headless,
			channel: this.config.channel,
			args: [
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-blink-features=AutomationControlled',
				'--disable-session-crashed-bubble',
				'--hide-crash-restore-bubble',
			],
			ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
		});

		this.state.context = await this.state.browser.newContext({
			viewport: this.config.viewport,
			deviceScaleFactor: this.config.deviceScaleFactor,
		});

		console.log('[BrowserPool] Browser initialized', {
			headless: this.config.headless,
			maxTabs: this.config.maxConcurrentTabs,
		});

		this.resetIdleTimer();
	}

	// =========================================================================
	// Page Management
	// =========================================================================

	/**
	 * Acquire a page from the pool.
	 * Creates a new page if under the limit, otherwise waits.
	 *
	 * @throws Error if pool is shutting down or max tabs reached
	 */
	async acquirePage(): Promise<Page> {
		if (this.state.isShuttingDown) {
			throw new Error('BrowserPool is shutting down');
		}

		await this.ensureInitialized();
		this.resetIdleTimer();

		// Try to find an available page
		for (const [id, pooledPage] of this.state.pages) {
			if (!pooledPage.inUse) {
				pooledPage.inUse = true;
				pooledPage.lastUsed = Date.now();
				console.log(`[BrowserPool] Reusing page ${id}`);
				return pooledPage.page;
			}
		}

		// Check if we can create a new page
		if (this.state.pages.size >= this.config.maxConcurrentTabs) {
			throw new Error(
				`BrowserPool: Max concurrent tabs (${this.config.maxConcurrentTabs}) reached`,
			);
		}

		// Create a new page - context is guaranteed to exist after ensureInitialized
		if (!this.state.context) {
			throw new Error('BrowserPool: Context not initialized');
		}
		const page = await this.state.context.newPage();
		const id = `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		this.state.pages.set(id, {
			page,
			inUse: true,
			lastUsed: Date.now(),
		});

		console.log(`[BrowserPool] Created new page ${id} (${this.state.pages.size} total)`);
		return page;
	}

	/**
	 * Release a page back to the pool.
	 * The page remains open for reuse.
	 */
	releasePage(page: Page): void {
		for (const [id, pooledPage] of this.state.pages) {
			if (pooledPage.page === page) {
				pooledPage.inUse = false;
				pooledPage.lastUsed = Date.now();
				console.log(`[BrowserPool] Released page ${id}`);
				this.resetIdleTimer();
				return;
			}
		}

		console.warn('[BrowserPool] Attempted to release unknown page');
	}

	/**
	 * Get the number of currently active (in-use) pages.
	 */
	getActiveCount(): number {
		let count = 0;
		for (const pooledPage of this.state.pages.values()) {
			if (pooledPage.inUse) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Get the total number of pages in the pool.
	 */
	getTotalCount(): number {
		return this.state.pages.size;
	}

	/**
	 * Check if the pool has an active browser.
	 */
	isInitialized(): boolean {
		return this.state.browser !== null;
	}

	// =========================================================================
	// Idle Management
	// =========================================================================

	/**
	 * Reset the idle timer.
	 * Browser closes after idleTimeoutMs of no activity.
	 */
	private resetIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}

		this.idleTimer = setTimeout(() => {
			this.handleIdleTimeout();
		}, this.config.idleTimeoutMs);
	}

	/**
	 * Handle idle timeout - close browser if no pages in use.
	 */
	private async handleIdleTimeout(): Promise<void> {
		const activeCount = this.getActiveCount();

		if (activeCount > 0) {
			console.log(`[BrowserPool] Idle timeout skipped, ${activeCount} pages still active`);
			this.resetIdleTimer();
			return;
		}

		console.log('[BrowserPool] Idle timeout, closing browser');
		await this.closeBrowser();
	}

	// =========================================================================
	// Cleanup
	// =========================================================================

	/**
	 * Close the browser and all pages.
	 */
	private async closeBrowser(): Promise<void> {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		// Close all pages
		for (const [id, pooledPage] of this.state.pages) {
			try {
				await pooledPage.page.close();
				console.log(`[BrowserPool] Closed page ${id}`);
			} catch (error) {
				console.warn(`[BrowserPool] Error closing page ${id}:`, error);
			}
		}
		this.state.pages.clear();

		// Close context
		if (this.state.context) {
			try {
				await this.state.context.close();
			} catch (error) {
				console.warn('[BrowserPool] Error closing context:', error);
			}
			this.state.context = null;
		}

		// Close browser
		if (this.state.browser) {
			try {
				await this.state.browser.close();
				console.log('[BrowserPool] Browser closed');
			} catch (error) {
				console.warn('[BrowserPool] Error closing browser:', error);
			}
			this.state.browser = null;
		}
	}

	/**
	 * Gracefully shutdown the pool.
	 * Waits for in-use pages to be released (with timeout).
	 *
	 * @param timeoutMs - Maximum time to wait for pages to be released
	 */
	async shutdown(timeoutMs = 10_000): Promise<void> {
		if (this.state.isShuttingDown) {
			return;
		}

		console.log('[BrowserPool] Initiating shutdown...');
		this.state.isShuttingDown = true;

		// Wait for active pages to be released
		const startTime = Date.now();
		while (this.getActiveCount() > 0) {
			if (Date.now() - startTime > timeoutMs) {
				console.warn(`[BrowserPool] Shutdown timeout, ${this.getActiveCount()} pages still active`);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		await this.closeBrowser();
		console.log('[BrowserPool] Shutdown complete');
	}
}

// =============================================================================
// Convenience Exports
// =============================================================================

/**
 * Get the browser pool instance.
 */
export function getBrowserPool(): BrowserPool {
	return BrowserPool.getInstance();
}
