import type { IncomingMessage } from 'node:http';

const DEFAULT_DEV_ORIGINS = [
	'http://localhost:3000',
	'http://localhost:3001',
	'http://localhost:3002',
	'http://127.0.0.1:3000',
	'http://127.0.0.1:3001',
	'http://127.0.0.1:3002',
];

export const CONTROL_TOKEN_HEADER = 'x-interceptor-token';

export class PayloadTooLargeError extends Error {
	constructor(public readonly maxBytes: number) {
		super(`Request body exceeds ${maxBytes} bytes`);
		this.name = 'PayloadTooLargeError';
	}
}

export interface SecurityConfig {
	environment: string;
	isProduction: boolean;
	controlToken: string | null;
	authDisabled: boolean;
	allowedOrigins: string[];
	maxHttpBodyBytes: number;
	wsMaxPayloadBytes: number;
	wsMessagesPerMinute: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseCsv(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

export function createSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
	const environment = env.NODE_ENV ?? 'development';
	const isProduction = environment === 'production';
	const controlToken = env.INTERCEPTOR_CONTROL_TOKEN || env.API_AUTH_TOKEN || null;
	const authDisabled = !isProduction && env.INTERCEPTOR_AUTH_DISABLED === 'true';

	if (isProduction && !controlToken) {
		throw new Error('INTERCEPTOR_CONTROL_TOKEN is required when NODE_ENV=production');
	}

	const configuredOrigins = parseCsv(env.INTERCEPTOR_ALLOWED_ORIGINS ?? env.CORS_ORIGIN);
	const allowedOrigins =
		configuredOrigins.length > 0 ? configuredOrigins : isProduction ? [] : DEFAULT_DEV_ORIGINS;

	return {
		environment,
		isProduction,
		controlToken,
		authDisabled,
		allowedOrigins,
		maxHttpBodyBytes: parsePositiveInt(env.INTERCEPTOR_MAX_HTTP_BODY_BYTES, 1_048_576),
		wsMaxPayloadBytes: parsePositiveInt(env.INTERCEPTOR_WS_MAX_PAYLOAD_BYTES, 64 * 1024),
		wsMessagesPerMinute: parsePositiveInt(env.INTERCEPTOR_WS_MESSAGES_PER_MINUTE, 120),
	};
}

export function isAllowedOrigin(
	origin: string | null | undefined,
	config: SecurityConfig,
): boolean {
	if (!origin) return !config.isProduction;
	if (config.allowedOrigins.includes(origin)) return true;

	if (!config.isProduction) {
		try {
			const { hostname } = new URL(origin);
			return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
		} catch {
			return false;
		}
	}

	return false;
}

function timingSafeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let index = 0; index < a.length; index += 1) {
		result |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return result === 0;
}

function bearerToken(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

export function isAuthorizedToken(
	candidate: string | null | undefined,
	config: SecurityConfig,
): boolean {
	if (config.authDisabled) return true;
	if (!config.controlToken) return !config.isProduction;
	if (!candidate) return false;
	return timingSafeEquals(candidate, config.controlToken);
}

export function isAuthorizedRequest(request: Request, config: SecurityConfig): boolean {
	if (config.authDisabled) return true;

	const url = new URL(request.url);
	const candidate =
		bearerToken(request.headers.get('authorization')) ??
		request.headers.get(CONTROL_TOKEN_HEADER) ??
		url.searchParams.get('token');

	return isAuthorizedToken(candidate, config);
}

export function isAuthorizedUpgrade(
	request: IncomingMessage,
	requestUrl: URL,
	config: SecurityConfig,
): boolean {
	if (config.authDisabled) return true;

	const authorization = Array.isArray(request.headers.authorization)
		? request.headers.authorization[0]
		: request.headers.authorization;
	const headerToken = request.headers[CONTROL_TOKEN_HEADER];
	const candidate =
		bearerToken(authorization ?? null) ??
		(Array.isArray(headerToken) ? headerToken[0] : headerToken) ??
		requestUrl.searchParams.get('token');

	return isAuthorizedToken(candidate, config);
}

export async function readRequestBody(
	request: IncomingMessage,
	maxBytes: number,
): Promise<string | undefined> {
	if (['GET', 'HEAD'].includes(request.method ?? 'GET')) return undefined;

	const chunks: Buffer[] = [];
	let total = 0;

	await new Promise<void>((resolve, reject) => {
		request.on('data', (chunk: Buffer) => {
			total += chunk.length;
			if (total > maxBytes) {
				reject(new PayloadTooLargeError(maxBytes));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve());
		request.on('error', reject);
	});

	return Buffer.concat(chunks).toString();
}
