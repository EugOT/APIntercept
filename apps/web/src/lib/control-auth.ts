const CONTROL_TOKEN_STORAGE_KEYS = ['interceptorControlToken', 'INTERCEPTOR_CONTROL_TOKEN'];

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

function normalizeWebSocketBase(value: string): string {
	const trimmed = trimTrailingSlash(value.trim());
	if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
	if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
	return trimmed;
}

function readTokenFromStorage(storage: Storage): string | null {
	for (const key of CONTROL_TOKEN_STORAGE_KEYS) {
		const token = storage.getItem(key)?.trim();
		if (token) return token;
	}
	return null;
}

export function getControlToken(): string | null {
	if (typeof window === 'undefined') return null;

	try {
		return readTokenFromStorage(window.sessionStorage) ?? readTokenFromStorage(window.localStorage);
	} catch {
		return null;
	}
}

export function createWebSocketUrl(pathAndQuery: string): string {
	if (typeof window === 'undefined') return pathAndQuery;

	const normalizedPath = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
	const configuredBase = process.env.NEXT_PUBLIC_INTERCEPTOR_WS_URL?.trim();
	if (configuredBase) return `${normalizeWebSocketBase(configuredBase)}${normalizedPath}`;

	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${protocol}//${window.location.host}${normalizedPath}`;
}

export async function createWebSocketTicket(): Promise<string | null> {
	try {
		const headers = new Headers();
		const token = getControlToken();
		if (token) headers.set('Authorization', `Bearer ${token}`);

		const response = await fetch('/browser/ws-ticket', {
			method: 'POST',
			headers,
			cache: 'no-store',
		});
		if (!response.ok) return null;

		const body = (await response.json()) as { ticket?: unknown };
		return typeof body.ticket === 'string' && body.ticket.length > 0 ? body.ticket : null;
	} catch {
		return null;
	}
}

export async function withWebSocketTicket(wsUrl: string): Promise<string> {
	const ticket = await createWebSocketTicket();
	if (!ticket) return wsUrl;

	const url = new URL(wsUrl);
	url.searchParams.set('ticket', ticket);
	return url.toString();
}
