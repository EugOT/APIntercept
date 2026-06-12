import type { InterceptedRequest, InterceptedResponse } from '../shared/types.js';

const REDACTED = '[REDACTED]';
const DEFAULT_MAX_BODY_SIZE = 50_000;
const DEFAULT_BODY_PREVIEW_SIZE = 2_000;

const SENSITIVE_HEADER_NAMES = new Set([
	'authorization',
	'cookie',
	'proxy-authorization',
	'set-cookie',
	'x-api-key',
	'x-auth-token',
	'x-csrf-token',
	'x-xsrf-token',
]);

const SENSITIVE_KEY_PATTERN =
	/(^|[_-])(api[-_]?key|auth|authorization|cookie|csrf|credential|password|secret|session|token)([_-]|$)/i;

export interface TrafficEntry {
	id: number;
	timestamp: number;
	method: string;
	url: string;
	requestHeaders: Record<string, string>;
	requestBody: unknown;
	status: number;
	responseHeaders: Record<string, string>;
	responseBody: unknown;
	durationMs: number;
}

export interface TrafficSanitizerOptions {
	captureRequestBodies: boolean;
	maxBodySize: number;
	bodyPreviewSize: number;
}

export function trafficOptionsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): TrafficSanitizerOptions {
	return {
		captureRequestBodies: env.INTERCEPTOR_CAPTURE_REQUEST_BODIES === 'true',
		maxBodySize: positiveInt(env.INTERCEPTOR_TRAFFIC_MAX_BODY_BYTES, DEFAULT_MAX_BODY_SIZE),
		bodyPreviewSize: positiveInt(
			env.INTERCEPTOR_TRAFFIC_BODY_PREVIEW_BYTES,
			DEFAULT_BODY_PREVIEW_SIZE,
		),
	};
}

function positiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isSensitiveHeader(name: string): boolean {
	const normalized = name.toLowerCase();
	return SENSITIVE_HEADER_NAMES.has(normalized) || SENSITIVE_KEY_PATTERN.test(normalized);
}

function redactCookieHeader(value: string): string {
	return value
		.split(';')
		.map((part) => {
			const [name] = part.trim().split('=');
			return name ? `${name}=${REDACTED}` : REDACTED;
		})
		.join('; ');
}

function redactSetCookieHeader(value: string): string {
	return value.replace(/(^|,\s*)([^=;,\s]+)=([^;,]*)/g, `$1$2=${REDACTED}`);
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const normalized = name.toLowerCase();
		if (normalized === 'cookie') {
			redacted[name] = redactCookieHeader(value);
		} else if (normalized === 'set-cookie') {
			redacted[name] = redactSetCookieHeader(value);
		} else if (isSensitiveHeader(name)) {
			redacted[name] = REDACTED;
		} else {
			redacted[name] = value;
		}
	}
	return redacted;
}

function redactSensitiveKeys(value: unknown, seen = new WeakSet<object>()): unknown {
	if (!value || typeof value !== 'object') return value;
	if (seen.has(value)) return '[Circular]';
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveKeys(item, seen));
	}

	const output: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitiveKeys(nested, seen);
	}
	return output;
}

export function sanitizeBody(
	value: unknown,
	options: TrafficSanitizerOptions,
	captureBody = true,
): unknown {
	if (value === undefined) return undefined;
	if (!captureBody) {
		return { _redacted: true, reason: 'request_body_capture_disabled' };
	}

	const redacted = redactSensitiveKeys(value);
	try {
		const bodyStr = JSON.stringify(redacted);
		if (bodyStr.length > options.maxBodySize) {
			return {
				_truncated: true,
				_size: bodyStr.length,
				_preview: bodyStr.slice(0, options.bodyPreviewSize),
			};
		}
	} catch {
		return { _redacted: true, reason: 'body_not_serializable' };
	}

	return redacted;
}

export function createTrafficEntry(
	id: number,
	req: InterceptedRequest,
	res: InterceptedResponse,
	options: TrafficSanitizerOptions,
): TrafficEntry {
	return {
		id,
		timestamp: req.timestamp,
		method: req.method,
		url: req.url,
		requestHeaders: redactHeaders(req.headers),
		requestBody: sanitizeBody(req.body, options, options.captureRequestBodies),
		status: res.status,
		responseHeaders: redactHeaders(res.headers),
		responseBody: sanitizeBody(res.body, options),
		durationMs: res.timestamp - req.timestamp,
	};
}
