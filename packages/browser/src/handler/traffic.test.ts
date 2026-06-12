import { describe, expect, test } from 'vitest';
import { createTrafficEntry, redactHeaders, sanitizeBody } from './traffic';

const options = {
	captureRequestBodies: false,
	maxBodySize: 80,
	bodyPreviewSize: 16,
};

describe('traffic sanitization', () => {
	test('redacts sensitive headers while preserving names', () => {
		expect(
			redactHeaders({
				Authorization: 'Bearer secret',
				Cookie: 'sid=abc; theme=dark',
				'Set-Cookie': 'sid=abc; Path=/, csrf=def; Path=/',
				Accept: 'application/json',
			}),
		).toEqual({
			Authorization: '[REDACTED]',
			Cookie: 'sid=[REDACTED]; theme=[REDACTED]',
			'Set-Cookie': 'sid=[REDACTED]; Path=/, csrf=[REDACTED]; Path=/',
			Accept: 'application/json',
		});
	});

	test('disables request body capture unless explicitly enabled', () => {
		expect(sanitizeBody({ token: 'secret' }, options, options.captureRequestBodies)).toEqual({
			_redacted: true,
			reason: 'request_body_capture_disabled',
		});
	});

	test('redacts sensitive object keys and truncates large bodies', () => {
		const body = sanitizeBody(
			{ token: 'secret', nested: { password: 'hunter2' }, data: 'x'.repeat(120) },
			{ ...options, captureRequestBodies: true },
		);

		expect(body).toMatchObject({
			_truncated: true,
			_size: expect.any(Number),
			_preview: expect.any(String),
		});
		expect(JSON.stringify(body)).not.toContain('secret');
		expect(JSON.stringify(body)).not.toContain('hunter2');
	});

	test('creates redacted traffic entries before buffering', () => {
		const entry = createTrafficEntry(
			1,
			{
				url: 'https://example.com/api',
				method: 'POST',
				headers: { Authorization: 'Bearer secret' },
				body: { sessionToken: 'secret' },
				timestamp: 10,
			},
			{
				url: 'https://example.com/api',
				status: 200,
				headers: { 'Set-Cookie': 'sid=secret; Path=/' },
				body: { ok: true },
				timestamp: 15,
			},
			options,
		);

		expect(entry.requestHeaders.Authorization).toBe('[REDACTED]');
		expect(entry.requestBody).toEqual({
			_redacted: true,
			reason: 'request_body_capture_disabled',
		});
		expect(entry.responseHeaders['Set-Cookie']).toBe('sid=[REDACTED]; Path=/');
		expect(entry.durationMs).toBe(5);
	});
});
