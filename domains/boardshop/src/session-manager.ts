/**
 * BoardShop Session Manager (Reference Example)
 *
 * Singleton that manages authenticated sessions across browser profiles.
 * Sessions are persisted to disk so they survive server restarts.
 *
 * PATTERN: Singleton + EventEmitter + Disk Persistence
 * - getInstance() for singleton access
 * - EventEmitter for SSE status broadcast to connected clients
 * - JSON file in the browser profile directory for persistence
 * - Token refresh tracking to detect stale auth before it expires
 *
 * @module domain-boardshop/session-manager
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfilePath } from '@interceptor/browser/remote/profiles';
import type { BoardShopHeaders, SessionEventType, SessionStatus } from './types.js';

/** Persisted session data */
export interface BoardShopSession {
	profileName: string;
	headers?: BoardShopHeaders;
	connectedAt?: number;
	lastTokenRefresh?: number;
	accountId?: string;
	verified: boolean;
	verificationError?: string;
}

/** Session event payload */
export interface SessionEvent {
	type: SessionEventType;
	profileName: string;
	status: SessionStatus;
}

// PATTERN: Token refresh threshold — refresh before expiry, not after.
// Set this to ~80% of the token's actual lifetime.
const TOKEN_REFRESH_THRESHOLD_MS = 20 * 60 * 60 * 1000; // 20 hours
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_FILE = 'boardshop-session.json';

/**
 * Singleton session manager with disk persistence and event broadcast.
 *
 * Usage:
 * ```typescript
 * const manager = BoardShopSessionManager.getInstance();
 *
 * // Store captured headers
 * manager.setHeaders('boardshop', capturedHeaders);
 *
 * // Check auth validity
 * if (manager.hasValidSession('boardshop')) {
 *   const headers = manager.getHeaders('boardshop');
 * }
 *
 * // Subscribe to status changes (for SSE)
 * manager.on('status', (event) => {
 *   console.log(`${event.profileName} is now ${event.type}`);
 * });
 * ```
 */
export class BoardShopSessionManager extends EventEmitter {
	private static instance: BoardShopSessionManager;
	private sessions: Map<string, BoardShopSession> = new Map();
	private maxAgeMs: number;

	private constructor(maxAgeMs = DEFAULT_MAX_AGE_MS) {
		super();
		this.setMaxListeners(50); // Allow multiple SSE connections
		this.maxAgeMs = maxAgeMs;
		this.loadPersistedSessions();
	}

	static getInstance(): BoardShopSessionManager {
		if (!BoardShopSessionManager.instance) {
			BoardShopSessionManager.instance = new BoardShopSessionManager();
		}
		return BoardShopSessionManager.instance;
	}

	/** Reset singleton (for testing) */
	static resetInstance(): void {
		BoardShopSessionManager.instance = new BoardShopSessionManager();
	}

	// ─── Session CRUD ─────────────────────────────────────────────────────────

	setHeaders(profileName: string, headers: BoardShopHeaders): void {
		const existing = this.sessions.get(profileName);
		const session: BoardShopSession = {
			profileName,
			headers,
			connectedAt: existing?.connectedAt ?? Date.now(),
			lastTokenRefresh: Date.now(),
			accountId: existing?.accountId,
			verified: existing?.verified ?? false,
		};
		this.sessions.set(profileName, session);
		this.persistSession(profileName, session);
		this.emitStatusChange('connected', profileName);
	}

	markVerified(profileName: string, accountId: string): void {
		const session = this.sessions.get(profileName);
		if (!session) return;
		session.verified = true;
		session.accountId = accountId;
		session.verificationError = undefined;
		this.persistSession(profileName, session);
		this.emitStatusChange('verified', profileName);
	}

	getHeaders(profileName: string): BoardShopHeaders | undefined {
		return this.sessions.get(profileName)?.headers;
	}

	hasValidSession(profileName: string): boolean {
		const session = this.sessions.get(profileName);
		if (!session?.headers || !session.connectedAt) return false;
		return Date.now() - session.connectedAt < this.maxAgeMs;
	}

	needsTokenRefresh(profileName: string): boolean {
		const session = this.sessions.get(profileName);
		if (!session?.lastTokenRefresh) return true;
		return Date.now() - session.lastTokenRefresh > TOKEN_REFRESH_THRESHOLD_MS;
	}

	getStatus(profileName: string): SessionStatus {
		const session = this.sessions.get(profileName);
		if (!session?.headers || !session.connectedAt) {
			return { status: 'disconnected', profileName };
		}
		if (Date.now() - session.connectedAt >= this.maxAgeMs) {
			return { status: 'expired', profileName, connectedAt: session.connectedAt };
		}
		return {
			status: 'connected',
			profileName,
			connectedAt: session.connectedAt,
			verified: session.verified,
			accountId: session.accountId,
			lastTokenRefresh: session.lastTokenRefresh,
			needsTokenRefresh: this.needsTokenRefresh(profileName),
		};
	}

	// ─── Disk Persistence ───────────────────────────────────────────────────

	// PATTERN: Persist to the browser profile directory. Each profile has its own
	// session file. This way, multiple profiles can have independent sessions.

	private persistSession(profileName: string, session: BoardShopSession): void {
		const profilePath = getProfilePath(profileName);
		if (!profilePath) return;
		const sessionPath = join(profilePath, SESSION_FILE);
		try {
			if (!existsSync(profilePath)) mkdirSync(profilePath, { recursive: true });
			writeFileSync(sessionPath, JSON.stringify(session, null, 2));
		} catch {
			// Disk write failure is non-fatal — session still in memory
		}
	}

	private loadPersistedSessions(): void {
		const profileName = 'boardshop';
		const profilePath = getProfilePath(profileName);
		if (!profilePath) return;
		const sessionPath = join(profilePath, SESSION_FILE);
		if (!existsSync(sessionPath)) return;
		try {
			const data = JSON.parse(readFileSync(sessionPath, 'utf-8')) as BoardShopSession;
			if (data.connectedAt && Date.now() - data.connectedAt < this.maxAgeMs) {
				this.sessions.set(profileName, data);
				this.emitStatusChange('restored', profileName);
			}
		} catch {
			// Corrupted file — start fresh
		}
	}

	// ─── Event Broadcast ────────────────────────────────────────────────────

	private emitStatusChange(type: SessionEventType, profileName: string): void {
		const event: SessionEvent = {
			type,
			profileName,
			status: this.getStatus(profileName),
		};
		this.emit('status', event);
	}
}
