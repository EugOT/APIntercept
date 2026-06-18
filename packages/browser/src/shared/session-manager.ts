/**
 * Generic Session Manager
 *
 * Server-side singleton that manages authentication sessions across all domains.
 * Stores captured headers per browser profile and tracks session validity.
 * Broadcasts status changes via EventEmitter for SSE subscribers.
 *
 * IMPORTANT: Sessions are persisted to disk so they survive server restarts.
 * Session files are stored in the browser profile directory.
 *
 * @module browser/shared/session-manager
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfilePath } from '../remote/profiles.js';
import type { GenericSession, SessionEvent, SessionEventType, SessionStatus } from './types.js';

/**
 * Default max age for sessions (30 days - browser cookies last this long).
 * The browser profile maintains login cookies that persist for ~30 days.
 * Bearer tokens expire after ~24 hours but are refreshed automatically
 * when the browser navigates to the domain.
 */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bearer token refresh threshold (20 hours).
 * Tokens should be refreshed before they expire (~24 hours).
 * When a session's token is older than this, needsTokenRefresh() returns true.
 */
export const TOKEN_REFRESH_THRESHOLD_MS = 20 * 60 * 60 * 1000;

/**
 * Session manager for domain-specific authentication sessions.
 *
 * Sessions are automatically persisted to disk per domain.
 *
 * Usage:
 * ```typescript
 * const boardshopMgr = GenericSessionManager.getInstance('boardshop');
 * const deckmarketMgr = GenericSessionManager.getInstance('deckmarket');
 *
 * // When headers are captured from interceptor
 * boardshopMgr.setHeaders('boardshop-main', capturedHeaders);
 *
 * // Check if we have valid auth
 * if (boardshopMgr.hasValidSession('boardshop-main')) {
 *   const headers = boardshopMgr.getHeaders('boardshop-main');
 *   // Use headers for API calls
 * }
 *
 * // Subscribe to status changes (for SSE)
 * boardshopMgr.on('status', (event) => {
 *   console.log(`Profile ${event.profileName} is now ${event.type}`);
 * });
 * ```
 */
export class GenericSessionManager extends EventEmitter {
	private static instances: Map<string, GenericSessionManager> = new Map();
	private sessions: Map<string, GenericSession> = new Map();
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: used by subclass and persistence methods
	private domainName: string;
	private sessionFileName: string;
	private maxAgeMs: number;

	private constructor(domainName: string, maxAgeMs = DEFAULT_MAX_AGE_MS) {
		super();
		// Allow more listeners for SSE connections from multiple browser tabs
		this.setMaxListeners(50);
		this.domainName = domainName;
		this.sessionFileName = `${domainName}-session.json`;
		this.maxAgeMs = maxAgeMs;
	}

	/**
	 * Get the singleton instance for a domain.
	 */
	static getInstance(domainName: string): GenericSessionManager {
		if (!GenericSessionManager.instances.has(domainName)) {
			GenericSessionManager.instances.set(domainName, new GenericSessionManager(domainName));
		}
		// biome-ignore lint/style/noNonNullAssertion: just set above if missing
		return GenericSessionManager.instances.get(domainName)!;
	}

	/**
	 * Reset all instances (for testing).
	 */
	static resetInstances(): void {
		GenericSessionManager.instances.clear();
	}

	/**
	 * Persist a session to disk.
	 */
	private saveSessionToDisk(profileName: string, session: GenericSession): void {
		try {
			const profilePath = getProfilePath(profileName);
			if (!profilePath) {
				console.log(
					`[SessionManager] Cannot save session - profile path not found: ${profileName}`,
				);
				return;
			}

			// Ensure directory exists
			if (!existsSync(profilePath)) {
				mkdirSync(profilePath, { recursive: true });
			}

			const sessionFile = join(profilePath, this.sessionFileName);
			writeFileSync(sessionFile, JSON.stringify(session, null, 2));
			console.log(`[SessionManager] Persisted session to disk`);
		} catch (err) {
			console.error(`[SessionManager] Failed to save session for ${profileName}:`, err);
		}
	}

	/**
	 * Load a persisted session from disk if it exists and hasn't expired.
	 * Called lazily on first getSession() for a profile. (BUG-17 fix)
	 */
	private loadSessionFromDisk(profileName: string): GenericSession | null {
		try {
			const profilePath = getProfilePath(profileName);
			if (!profilePath) return null;

			const sessionFile = join(profilePath, this.sessionFileName);
			if (!existsSync(sessionFile)) return null;

			const data = JSON.parse(readFileSync(sessionFile, 'utf-8')) as GenericSession;

			// Check if session has expired
			if (data.connectedAt && Date.now() - data.connectedAt > this.maxAgeMs) {
				console.log(`[SessionManager] Expired session on disk for ${profileName}, ignoring`);
				return null;
			}

			console.log(`[SessionManager] Loaded session from disk for ${profileName}`);
			return data;
		} catch {
			return null;
		}
	}

	/**
	 * Delete persisted session from disk.
	 */
	private deleteSessionFromDisk(profileName: string): void {
		try {
			const profilePath = getProfilePath(profileName);
			if (!profilePath) return;

			const sessionFile = join(profilePath, this.sessionFileName);
			if (existsSync(sessionFile)) {
				unlinkSync(sessionFile);
				console.log(`[SessionManager] Deleted session file from disk`);
			}
		} catch (err) {
			console.error(`[SessionManager] Failed to delete session for ${profileName}:`, err);
		}
	}

	/**
	 * Emit a status change event for SSE subscribers.
	 */
	private emitStatusChange(type: SessionEventType, profileName: string): void {
		const event: SessionEvent = {
			type,
			profileName,
			status: this.getStatus(profileName),
		};
		this.emit('status', event);
	}

	/**
	 * Update session with captured headers.
	 * Note: This sets verified=false - call verifySession() to validate.
	 */
	setHeaders(profileName: string, headers: Record<string, string>, accountNumber?: string): void {
		const existing = this.sessions.get(profileName);
		const now = Date.now();
		const session: GenericSession = {
			profileName,
			headers,
			// Keep original connectedAt if refreshing an existing session
			connectedAt: existing?.connectedAt || now,
			lastTokenRefresh: now,
			accountNumber: accountNumber || existing?.accountNumber,
			firstName: existing?.firstName,
			lastName: existing?.lastName,
			buyingPower: existing?.buyingPower,
			// Keep verified status if refreshing (same account)
			verified: !!(existing?.verified && existing?.accountNumber === accountNumber),
		};
		this.sessions.set(profileName, session);
		this.saveSessionToDisk(profileName, session);
		const isRefresh = existing?.connectedAt ? ' (token refresh)' : ' (new session)';
		console.log(`[SessionManager] Headers captured for ${profileName}${isRefresh}`);
		this.emitStatusChange('connected', profileName);
	}

	/**
	 * Mark session as verified with account details.
	 */
	markVerified(
		profileName: string,
		details: {
			accountNumber: string;
			firstName?: string;
			lastName?: string;
			buyingPower?: string;
		},
	): void {
		const existing = this.sessions.get(profileName);
		if (existing) {
			existing.verified = true;
			existing.accountNumber = details.accountNumber;
			existing.firstName = details.firstName;
			existing.lastName = details.lastName;
			existing.buyingPower = details.buyingPower;
			existing.verificationError = undefined;
			this.sessions.set(profileName, existing);
			this.saveSessionToDisk(profileName, existing);
			console.log(
				`[SessionManager] ✅ VERIFIED ${profileName}: ${details.firstName} ${details.lastName} (${details.accountNumber})`,
			);
			this.emitStatusChange('verified', profileName);
		}
	}

	/**
	 * Mark session verification as failed.
	 */
	markVerificationFailed(profileName: string, error: string): void {
		const existing = this.sessions.get(profileName);
		if (existing) {
			existing.verified = false;
			existing.verificationError = error;
			this.sessions.set(profileName, existing);
			this.saveSessionToDisk(profileName, existing);
			console.log(`[SessionManager] ❌ Verification failed for ${profileName}: ${error}`);
			this.emitStatusChange('verification_failed', profileName);
		}
	}

	/**
	 * Update account number for a session.
	 */
	setAccountNumber(profileName: string, accountNumber: string): void {
		const existing = this.sessions.get(profileName);
		if (existing) {
			existing.accountNumber = accountNumber;
			this.sessions.set(profileName, existing);
			this.saveSessionToDisk(profileName, existing);
		}
	}

	/**
	 * Get headers for a profile (if valid).
	 */
	getHeaders(profileName: string): Record<string, string> | null {
		const session = this.sessions.get(profileName);
		if (!session?.headers) {
			return null;
		}
		if (!this.isSessionValid(session)) {
			return null;
		}
		return session.headers;
	}

	/**
	 * Get current session state for a profile.
	 */
	getSession(profileName: string): GenericSession | null {
		const inMemory = this.sessions.get(profileName);
		if (inMemory) return inMemory;

		// Try loading from disk on first access (BUG-17 fix)
		const fromDisk = this.loadSessionFromDisk(profileName);
		if (fromDisk) {
			this.sessions.set(profileName, fromDisk);
			return fromDisk;
		}

		return null;
	}

	/**
	 * Get session status for API response.
	 */
	getStatus(profileName: string): SessionStatus {
		const session = this.sessions.get(profileName);

		if (!session?.headers) {
			return { status: 'disconnected', profileName };
		}

		if (!this.isSessionValid(session)) {
			return {
				status: 'expired',
				profileName,
				connectedAt: session.connectedAt ?? Date.now(),
			};
		}

		return {
			status: 'connected',
			profileName,
			connectedAt: session.connectedAt ?? Date.now(),
			verified: session.verified,
			accountNumber: session.accountNumber,
			firstName: session.firstName,
			lastName: session.lastName,
			buyingPower: session.buyingPower,
			verificationError: session.verificationError,
			lastTokenRefresh: session.lastTokenRefresh,
			needsTokenRefresh: this.needsTokenRefresh(profileName),
		};
	}

	/**
	 * Check if a profile has valid (non-expired) headers.
	 */
	hasValidSession(profileName: string): boolean {
		const session = this.sessions.get(profileName);
		if (!session?.headers) return false;
		return this.isSessionValid(session);
	}

	/**
	 * Clear session for a profile.
	 * @param profileName - The profile to clear
	 * @param options.force - If true, clear even if session is verified. Required for verified sessions.
	 * @returns true if session was cleared, false if blocked
	 */
	clearSession(profileName: string, options?: { force?: boolean }): boolean {
		const session = this.sessions.get(profileName);

		// Protect verified sessions from accidental clearing
		if (session?.verified && !options?.force) {
			console.log(
				`[SessionManager] BLOCKED: Cannot clear verified session for ${profileName} without force=true`,
			);
			return false;
		}

		this.sessions.delete(profileName);
		this.deleteSessionFromDisk(profileName);
		console.log(
			`[SessionManager] Session cleared for ${profileName} (force=${options?.force ?? false})`,
		);
		this.emitStatusChange('disconnected', profileName);
		return true;
	}

	/**
	 * List all active profiles with sessions.
	 */
	listSessions(): string[] {
		return Array.from(this.sessions.keys());
	}

	/**
	 * Check if session is still valid (not expired).
	 */
	private isSessionValid(session: GenericSession): boolean {
		if (!session.connectedAt) return false;
		return Date.now() - session.connectedAt < this.maxAgeMs;
	}

	/**
	 * Check if the Bearer token needs refreshing.
	 * Tokens expire after ~24 hours, so we refresh at 20 hours.
	 * The browser profile cookies keep us logged in for 30 days,
	 * but we need fresh Bearer tokens for API calls.
	 */
	needsTokenRefresh(profileName: string): boolean {
		const session = this.sessions.get(profileName);
		if (!session?.headers) return false;

		// Use lastTokenRefresh if available, otherwise fall back to connectedAt
		const tokenTime = session.lastTokenRefresh || session.connectedAt;
		if (!tokenTime) return true;

		const tokenAge = Date.now() - tokenTime;
		return tokenAge > TOKEN_REFRESH_THRESHOLD_MS;
	}

	/**
	 * Get the age of the current Bearer token in milliseconds.
	 */
	getTokenAge(profileName: string): number | null {
		const session = this.sessions.get(profileName);
		if (!session?.headers) return null;

		const tokenTime = session.lastTokenRefresh || session.connectedAt;
		if (!tokenTime) return null;

		return Date.now() - tokenTime;
	}

	/**
	 * Update session with refreshed headers (new Bearer token).
	 * Called after navigating the browser to the domain and capturing new headers.
	 * This resets the token refresh timer without changing connectedAt.
	 */
	refreshToken(profileName: string, headers: Record<string, string>): void {
		const existing = this.sessions.get(profileName);
		if (!existing) {
			console.log(`[SessionManager] Cannot refresh token - no session for ${profileName}`);
			return;
		}

		// Update headers and token refresh time, keep original connectedAt
		existing.headers = headers;
		existing.lastTokenRefresh = Date.now();
		this.sessions.set(profileName, existing);
		this.saveSessionToDisk(profileName, existing);

		const sessionAge = existing.connectedAt ? Date.now() - existing.connectedAt : 0;
		const sessionDays = Math.floor(sessionAge / (24 * 60 * 60 * 1000));
		console.log(
			`[SessionManager] ✅ Token refreshed for ${profileName} (session age: ${sessionDays} days)`,
		);
	}
}
