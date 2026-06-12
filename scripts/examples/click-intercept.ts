/**
 * Click-Intercept Pagination Example
 *
 * Demonstrates the click-intercept pattern against the boardshop test-server.
 * Navigate to the resale page, click "Load More Listings", and intercept the
 * POST responses to collect all paginated data.
 *
 * Usage:
 *   bun run --filter @interceptor/test-server start  # Start test-server on 4444
 *   bun run tsx scripts/examples/click-intercept.ts
 *
 * The pattern:
 *   1. Launch Patchright browser
 *   2. Set up response interception (page.on('response'))
 *   3. Navigate to the page
 *   4. Click pagination button ("Load More", "Show more", "Next")
 *   5. Intercepted responses contain the paginated data
 *   6. Loop until no more button or itemsRemaining === 0
 */

import { chromium } from 'patchright';

const BASE_URL = 'http://localhost:4444/sites/boardshop';

async function main() {
	console.log('[1] Launching browser...');
	const ctx = await chromium.launchPersistentContext('', {
		headless: true,
		channel: 'chromium',
		args: ['--disable-blink-features=AutomationControlled'],
	});
	const page = await ctx.newPage();

	// Collect POST responses
	const allItems: unknown[] = [];
	let totalCount = 0;

	page.on('response', async (res) => {
		if (res.request().method() === 'POST' && res.status() === 200) {
			try {
				const json = (await res.json()) as {
					items: unknown[];
					total: number;
					hasMore: boolean;
					currentPage: number;
				};
				if (json.items && json.items.length > 0) {
					allItems.push(...json.items);
					totalCount = json.total;
					console.log(
						`  [intercepted] Page ${json.currentPage}: ${json.items.length} items (${allItems.length}/${totalCount} total)`,
					);
				}
			} catch {
				// Not JSON or different format — skip
			}
		}
	});

	console.log('[2] Navigating to resale page...');
	await page.goto(`${BASE_URL}/resale`);
	await page.waitForTimeout(2000);

	// Get initial embedded data count
	const initialCount = await page.evaluate(() => {
		const cards = document.querySelectorAll('[data-testid="listing-card"]');
		return cards.length;
	});
	console.log(`[3] Initial items on page: ${initialCount}`);

	// Click "Load More" until it disappears
	let clicks = 0;
	while (true) {
		const btn = page.locator('[data-action="load-more"]');
		const visible = await btn.isVisible().catch(() => false);
		if (!visible) {
			console.log('[4] No more "Load More" button — done.');
			break;
		}

		clicks++;
		console.log(`[4] Clicking "Load More" (#${clicks})...`);
		await btn.click();
		await page.waitForTimeout(1000);

		// Safety limit
		if (clicks > 20) {
			console.log('[4] Reached 20 clicks — stopping.');
			break;
		}
	}

	console.log('\n=== Results ===');
	console.log(`Initial embedded items: ${initialCount}`);
	console.log(`Items from pagination: ${allItems.length}`);
	console.log(`Total items (embedded + paginated): ${initialCount + allItems.length}`);
	console.log(`Server total: ${totalCount}`);
	console.log(`Clicks needed: ${clicks}`);

	await ctx.close();
}

main().catch(console.error);
