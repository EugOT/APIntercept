/**
 * BoardShop API Client (Reference Example)
 *
 * Makes authenticated API calls using captured headers. Demonstrates:
 * - Credential verification with real API call
 * - Paginated list endpoint with cursor
 * - Single-item fetch with caching (Map-based)
 * - Write operation with Zod validation
 *
 * PATTERN: The API client is stateless — it receives headers on each call.
 * Session state lives in the SessionManager, not here. This separation
 * makes the client testable and reusable across different session sources.
 *
 * @module domain-boardshop/api-client
 */

import {
	type Board,
	type BoardShopHeaders,
	type Order,
	OrderResponseSchema,
	type PaginatedBoards,
	PaginatedBoardsSchema,
} from './types.js';

const API_BASE = 'https://api.boardshop.example.com/v1';

// PATTERN: Cache frequently-accessed immutable data to avoid redundant lookups.
// SKU → Board mapping. Clear on server restart (module-level Map).
const boardCache = new Map<string, Board>();

/** Build standard headers for API requests */
function buildHeaders(auth: BoardShopHeaders): Record<string, string> {
	return {
		Authorization: auth.Authorization,
		'X-Shop-Session': auth['X-Shop-Session'],
		'Content-Type': 'application/json',
		Accept: 'application/json',
	};
}

/** Standard fetch wrapper with error handling */
async function apiFetch<T>(
	url: string,
	headers: Record<string, string>,
	schema: { parse: (data: unknown) => T },
	options?: RequestInit,
): Promise<T> {
	const res = await fetch(url, { ...options, headers });
	if (!res.ok) {
		throw new Error(`BoardShop API ${res.status}: ${await res.text()}`);
	}
	const data = await res.json();
	return schema.parse(data);
}

// ─── Verification ─────────────────────────────────────────────────────────
// PATTERN: verifyCredentials makes a lightweight API call to confirm
// the captured headers are valid. Return account info for the session.

export interface VerificationResult {
	valid: boolean;
	accountId?: string;
	displayName?: string;
	error?: string;
}

export async function verifyCredentials(headers: BoardShopHeaders): Promise<VerificationResult> {
	try {
		const res = await fetch(`${API_BASE}/account/profile`, {
			headers: buildHeaders(headers),
		});
		if (!res.ok) {
			return { valid: false, error: `API returned ${res.status}` };
		}
		const profile = (await res.json()) as { id: string; name: string };
		return { valid: true, accountId: profile.id, displayName: profile.name };
	} catch (err) {
		return { valid: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ─── Read Operations ────────────────────────────────────────────────────────

/**
 * PATTERN: Paginated list with cursor.
 * Pass `cursor` from the previous response's `next` field to get the next page.
 * When `next` is null, there are no more pages.
 */
export async function listBoards(
	headers: BoardShopHeaders,
	cursor?: string,
): Promise<PaginatedBoards> {
	const params = new URLSearchParams();
	if (cursor) params.set('cursor', cursor);
	const url = `${API_BASE}/boards${params.toString() ? `?${params}` : ''}`;
	return apiFetch(url, buildHeaders(headers), PaginatedBoardsSchema);
}

/**
 * PATTERN: Single-item fetch with cache.
 * Cache hit returns immediately. Cache miss fetches, stores, returns.
 * Cache is module-level Map — resets on server restart (intentional).
 */
export async function getBoard(headers: BoardShopHeaders, sku: string): Promise<Board> {
	const cached = boardCache.get(sku);
	if (cached) return cached;

	const res = await fetch(`${API_BASE}/boards/${encodeURIComponent(sku)}`, {
		headers: buildHeaders(headers),
	});
	if (!res.ok) throw new Error(`Board ${sku} not found: ${res.status}`);

	const data = (await res.json()) as Board;
	boardCache.set(sku, data);
	return data;
}

// ─── Write Operations ───────────────────────────────────────────────────────

/**
 * PATTERN: Write operation with Zod validation on the response.
 * Validates that the server returned the expected shape.
 * If the server returns unexpected data, the Zod parse throws immediately
 * instead of letting bad data propagate through the UI.
 */
export async function createOrder(
	headers: BoardShopHeaders,
	params: { sku: string; quantity: number },
): Promise<Order> {
	const result = await apiFetch(`${API_BASE}/orders`, buildHeaders(headers), OrderResponseSchema, {
		method: 'POST',
		body: JSON.stringify(params),
	});
	return result.order;
}

// ─── Batch Operations ───────────────────────────────────────────────────────
// PATTERN: When fetching many items by ID, batch into chunks to avoid
// URL length limits and rate limiting. Process chunks sequentially.

export async function getBoardsBatch(
	headers: BoardShopHeaders,
	skus: string[],
	chunkSize = 40,
): Promise<Board[]> {
	const results: Board[] = [];
	for (let i = 0; i < skus.length; i += chunkSize) {
		const chunk = skus.slice(i, i + chunkSize);
		const ids = chunk.map(encodeURIComponent).join(',');
		const res = await fetch(`${API_BASE}/boards?skus=${ids}`, {
			headers: buildHeaders(headers),
		});
		if (res.ok) {
			const data = (await res.json()) as { results: Board[] };
			for (const board of data.results) {
				boardCache.set(board.sku, board);
				results.push(board);
			}
		}
	}
	return results;
}
