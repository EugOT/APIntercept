/**
 * Scraper Registry
 *
 * Centralized registry for all scraper implementations.
 * Provides discovery, validation, and coordination for scaling to 100s of scrapers.
 *
 * ## Architecture
 *
 * Each scraper has:
 * - Unique ID (e.g., 'investing.earnings', 'tradingeconomics.calendar')
 * - Metadata (name, description, schedule hints, rate limits)
 * - Fetch function returning Result<T, ScraperError>
 * - Optional health check
 *
 * ## Usage
 *
 * ```typescript
 * import { ScraperRegistry } from '@interceptor/browser';
 *
 * // Get registry singleton
 * const registry = ScraperRegistry.getInstance();
 *
 * // List all scrapers
 * const all = registry.listScrapers();
 *
 * // Get specific scraper
 * const earnings = registry.getScraper('investing.earnings');
 *
 * // Run health checks
 * const health = await registry.checkHealth();
 * ```
 *
 * @module @interceptor/browser/registry
 */

import type { Result, ScraperError } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Scraper schedule hint for job scheduling.
 */
export interface ScraperSchedule {
	/** Schedule type */
	type: 'cron' | 'interval' | 'manual';
	/** Cron expression (for cron type) */
	cron?: string;
	/** Interval in ms (for interval type) */
	intervalMs?: number;
	/** Human-readable description */
	description?: string;
}

/**
 * Rate limit configuration for a scraper.
 */
export interface ScraperRateLimit {
	/** Minimum ms between requests */
	minIntervalMs: number;
	/** Max concurrent requests */
	maxConcurrent?: number;
	/** Daily request limit (for quota-based sources) */
	dailyLimit?: number;
}

/**
 * Scraper metadata for registry.
 */
export interface ScraperMeta {
	/** Unique scraper ID (e.g., 'investing.earnings') */
	id: string;
	/** Human-readable name */
	name: string;
	/** Description of what this scraper fetches */
	description: string;
	/** Data source (e.g., 'boardshop.com', 'deckmarket.com') */
	source: string;
	/** Version string */
	version: string;
	/** Whether browser automation is required */
	requiresBrowser: boolean;
	/** Schedule hints for job configuration */
	schedule?: ScraperSchedule;
	/** Rate limiting configuration */
	rateLimit?: ScraperRateLimit;
	/** Tags for categorization */
	tags?: string[];
}

/**
 * Health check result for a scraper.
 */
export interface ScraperHealthResult {
	/** Scraper ID */
	id: string;
	/** Whether the scraper is healthy */
	healthy: boolean;
	/** Response time in ms */
	responseTimeMs: number;
	/** Error message if unhealthy */
	error?: string;
	/** Timestamp of check */
	checkedAt: Date;
}

/**
 * Generic scraper fetch function type.
 */
export type ScraperFetchFn<TOptions, TResult> = (
	options: TOptions,
) => Promise<Result<TResult, ScraperError>>;

/**
 * Health check function type.
 */
export type ScraperHealthCheckFn = () => Promise<ScraperHealthResult>;

/**
 * Registered scraper entry.
 */
export interface RegisteredScraper<TOptions = unknown, TResult = unknown> {
	meta: ScraperMeta;
	fetch: ScraperFetchFn<TOptions, TResult>;
	healthCheck?: ScraperHealthCheckFn;
}

// =============================================================================
// Registry Implementation
// =============================================================================

/**
 * Central registry for all scrapers.
 *
 * Singleton pattern ensures consistent state across the application.
 */
export class ScraperRegistry {
	private static instance: ScraperRegistry | null = null;
	private scrapers: Map<string, RegisteredScraper> = new Map();

	private constructor() {}

	/**
	 * Get the singleton instance.
	 */
	static getInstance(): ScraperRegistry {
		if (!ScraperRegistry.instance) {
			ScraperRegistry.instance = new ScraperRegistry();
		}
		return ScraperRegistry.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		ScraperRegistry.instance = null;
	}

	// =========================================================================
	// Registration
	// =========================================================================

	/**
	 * Register a scraper with the registry.
	 *
	 * @param scraper - Scraper configuration to register
	 * @throws Error if scraper ID is already registered
	 */
	register<TOptions, TResult>(scraper: RegisteredScraper<TOptions, TResult>): void {
		const { id } = scraper.meta;

		if (this.scrapers.has(id)) {
			throw new Error(`Scraper '${id}' is already registered`);
		}

		this.scrapers.set(id, scraper as RegisteredScraper);
	}

	/**
	 * Unregister a scraper from the registry.
	 *
	 * @param id - Scraper ID to unregister
	 * @returns true if scraper was removed, false if not found
	 */
	unregister(id: string): boolean {
		return this.scrapers.delete(id);
	}

	// =========================================================================
	// Discovery
	// =========================================================================

	/**
	 * Get a scraper by ID.
	 *
	 * @param id - Scraper ID
	 * @returns Scraper or undefined if not found
	 */
	getScraper<TOptions = unknown, TResult = unknown>(
		id: string,
	): RegisteredScraper<TOptions, TResult> | undefined {
		return this.scrapers.get(id) as RegisteredScraper<TOptions, TResult> | undefined;
	}

	/**
	 * List all registered scrapers.
	 *
	 * @returns Array of scraper metadata
	 */
	listScrapers(): ScraperMeta[] {
		return Array.from(this.scrapers.values()).map((s) => s.meta);
	}

	/**
	 * Find scrapers by source.
	 *
	 * @param source - Source name (e.g., 'boardshop.com')
	 * @returns Array of matching scrapers
	 */
	findBySource(source: string): RegisteredScraper[] {
		return Array.from(this.scrapers.values()).filter(
			(s) => s.meta.source.toLowerCase() === source.toLowerCase(),
		);
	}

	/**
	 * Find scrapers by tag.
	 *
	 * @param tag - Tag to search for
	 * @returns Array of matching scrapers
	 */
	findByTag(tag: string): RegisteredScraper[] {
		return Array.from(this.scrapers.values()).filter((s) => s.meta.tags?.includes(tag));
	}

	/**
	 * Find scrapers that require browser automation.
	 */
	findBrowserScrapers(): RegisteredScraper[] {
		return Array.from(this.scrapers.values()).filter((s) => s.meta.requiresBrowser);
	}

	/**
	 * Find scrapers that don't require browser automation.
	 */
	findApiScrapers(): RegisteredScraper[] {
		return Array.from(this.scrapers.values()).filter((s) => !s.meta.requiresBrowser);
	}

	// =========================================================================
	// Health Checks
	// =========================================================================

	/**
	 * Run health check for a specific scraper.
	 *
	 * @param id - Scraper ID
	 * @returns Health check result or undefined if no health check defined
	 */
	async checkScraperHealth(id: string): Promise<ScraperHealthResult | undefined> {
		const scraper = this.scrapers.get(id);
		if (!scraper?.healthCheck) {
			return undefined;
		}

		try {
			return await scraper.healthCheck();
		} catch (error) {
			return {
				id,
				healthy: false,
				responseTimeMs: 0,
				error: error instanceof Error ? error.message : String(error),
				checkedAt: new Date(),
			};
		}
	}

	/**
	 * Run health checks for all scrapers with health check functions.
	 *
	 * @returns Array of health check results
	 */
	async checkAllHealth(): Promise<ScraperHealthResult[]> {
		const results: ScraperHealthResult[] = [];

		for (const [id, scraper] of this.scrapers) {
			if (scraper.healthCheck) {
				const result = await this.checkScraperHealth(id);
				if (result) {
					results.push(result);
				}
			}
		}

		return results;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get count of registered scrapers.
	 */
	get count(): number {
		return this.scrapers.size;
	}

	/**
	 * Check if a scraper is registered.
	 */
	has(id: string): boolean {
		return this.scrapers.has(id);
	}

	/**
	 * Clear all registered scrapers (for testing).
	 */
	clear(): void {
		this.scrapers.clear();
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a simple health check function that tests connectivity.
 *
 * @param fetchFn - Fetch function to test
 * @param testOptions - Options to pass to fetch function
 * @returns Health check function
 */
export function createHealthCheck<TOptions, TResult>(
	id: string,
	fetchFn: ScraperFetchFn<TOptions, TResult>,
	testOptions: TOptions,
): ScraperHealthCheckFn {
	return async (): Promise<ScraperHealthResult> => {
		const startTime = Date.now();

		try {
			const result = await fetchFn(testOptions);
			const responseTimeMs = Date.now() - startTime;

			if (result.ok) {
				return {
					id,
					healthy: true,
					responseTimeMs,
					checkedAt: new Date(),
				};
			}

			return {
				id,
				healthy: false,
				responseTimeMs,
				error: result.error.message,
				checkedAt: new Date(),
			};
		} catch (error) {
			return {
				id,
				healthy: false,
				responseTimeMs: Date.now() - startTime,
				error: error instanceof Error ? error.message : String(error),
				checkedAt: new Date(),
			};
		}
	};
}

/**
 * Define and register a scraper in one call.
 *
 * @param meta - Scraper metadata
 * @param fetch - Fetch function
 * @param healthCheck - Optional health check function
 * @returns The registered scraper
 */
export function defineScraper<TOptions, TResult>(
	meta: ScraperMeta,
	fetch: ScraperFetchFn<TOptions, TResult>,
	healthCheck?: ScraperHealthCheckFn,
): RegisteredScraper<TOptions, TResult> {
	const scraper: RegisteredScraper<TOptions, TResult> = {
		meta,
		fetch,
		healthCheck,
	};

	ScraperRegistry.getInstance().register(scraper);

	return scraper;
}

// =============================================================================
// Export singleton getter
// =============================================================================

/**
 * Get the global scraper registry instance.
 */
export function getScraperRegistry(): ScraperRegistry {
	return ScraperRegistry.getInstance();
}
