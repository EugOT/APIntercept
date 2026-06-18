/**
 * Browser Lifecycle Manager
 *
 * Ensures only one browser instance runs at a time for the /browser endpoint.
 * Uses in-memory singleton tracking - the API process manages browser lifecycles.
 *
 * The scraper uses its own browser management and is separate from this.
 *
 * @module browser/remote
 */

import type { RemoteBrowserService } from './service.js';

/**
 * Simple async mutex for serializing browser operations
 */
class BrowserMutex {
	private locked = false;
	private waitQueue: Array<() => void> = [];

	async acquire(timeoutMs = 30_000): Promise<void> {
		if (!this.locked) {
			this.locked = true;
			return;
		}

		// Wait for lock to be released, with timeout
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waitQueue.indexOf(resolve);
				if (idx !== -1) this.waitQueue.splice(idx, 1);
				// Force-release the lock to recover from deadlock
				this.locked = false;
				reject(new Error(`BrowserMutex: acquire timed out after ${timeoutMs}ms — force-released`));
			}, timeoutMs);

			this.waitQueue.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	release(): void {
		if (this.waitQueue.length > 0) {
			// Give lock to next waiter
			const next = this.waitQueue.shift();
			next?.();
		} else {
			this.locked = false;
		}
	}

	isLocked(): boolean {
		return this.locked;
	}

	getQueueLength(): number {
		return this.waitQueue.length;
	}
}

export class BrowserLifecycleManager {
	private static instance: BrowserLifecycleManager | null = null;

	private activeBrowser: RemoteBrowserService | null = null;
	private isStarting = false;
	private sessionId = 0;
	private mutex = new BrowserMutex();

	// Timing metrics
	private lastStartTime: number | null = null;
	private lastStopTime: number | null = null;

	private constructor() {}

	static getInstance(): BrowserLifecycleManager {
		if (!BrowserLifecycleManager.instance) {
			BrowserLifecycleManager.instance = new BrowserLifecycleManager();
		}
		return BrowserLifecycleManager.instance;
	}

	/**
	 * Acquire exclusive lock for browser operations.
	 * Use with try/finally to ensure release.
	 */
	async acquireLock(): Promise<void> {
		const queuePos = this.mutex.getQueueLength();
		if (queuePos > 0) {
			console.log(`[BrowserLifecycleManager] Waiting for lock (${queuePos} ahead in queue)`);
		}
		await this.mutex.acquire();
		console.log(`[BrowserLifecycleManager] Lock acquired (session ${this.sessionId + 1})`);
	}

	/**
	 * Release the browser operation lock.
	 */
	releaseLock(): void {
		this.mutex.release();
		console.log(`[BrowserLifecycleManager] Lock released`);
	}

	/**
	 * Check if lock is currently held.
	 */
	isLocked(): boolean {
		return this.mutex.isLocked();
	}

	/**
	 * Check if another browser start is in progress.
	 */
	isStartingBrowser(): boolean {
		return this.isStarting;
	}

	/**
	 * Mark that we're starting a browser (mutex-like).
	 */
	startingBrowser(): void {
		this.isStarting = true;
	}

	/**
	 * Mark that browser start is complete.
	 */
	finishedStarting(): void {
		this.isStarting = false;
	}

	/**
	 * Register a browser instance.
	 * @returns Session ID for this browser
	 */
	registerBrowser(browser: RemoteBrowserService): number {
		this.sessionId++;
		this.activeBrowser = browser;
		this.lastStartTime = Date.now();
		console.log(`[BrowserLifecycleManager] Registered browser session ${this.sessionId}`);
		return this.sessionId;
	}

	/**
	 * Unregister the browser.
	 */
	unregisterBrowser(): void {
		console.log(`[BrowserLifecycleManager] Unregistered browser session ${this.sessionId}`);
		this.activeBrowser = null;
		this.lastStopTime = Date.now();
	}

	/**
	 * Get the current active browser, if any.
	 */
	getActiveBrowser(): RemoteBrowserService | null {
		return this.activeBrowser;
	}

	/**
	 * Check if a browser is currently registered.
	 */
	hasBrowser(): boolean {
		return this.activeBrowser !== null;
	}

	/**
	 * Get status info for health/debugging endpoints.
	 */
	getStatus(): {
		hasBrowser: boolean;
		sessionId: number;
		isLocked: boolean;
		queueLength: number;
		lastStartTime: number | null;
		lastStopTime: number | null;
		uptimeSeconds: number | null;
	} {
		return {
			hasBrowser: this.activeBrowser !== null,
			sessionId: this.sessionId,
			isLocked: this.mutex.isLocked(),
			queueLength: this.mutex.getQueueLength(),
			lastStartTime: this.lastStartTime,
			lastStopTime: this.lastStopTime,
			uptimeSeconds:
				this.lastStartTime && !this.lastStopTime
					? Math.round((Date.now() - this.lastStartTime) / 1000)
					: null,
		};
	}

	/**
	 * Stop any existing browser. Returns true if a browser was stopped.
	 */
	async stopExistingBrowser(): Promise<boolean> {
		if (this.activeBrowser) {
			console.log(`[BrowserLifecycleManager] Stopping existing browser session ${this.sessionId}`);
			try {
				await this.activeBrowser.stop();
				this.activeBrowser = null;
				return true;
			} catch (err) {
				console.error(`[BrowserLifecycleManager] Error stopping browser:`, err);
				this.activeBrowser = null;
				return false;
			}
		}
		return false;
	}
}
