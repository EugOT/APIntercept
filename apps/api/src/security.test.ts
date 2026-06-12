import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import {
	CONTROL_TOKEN_HEADER,
	createSecurityConfig,
	isAllowedOrigin,
	isAuthorizedRequest,
	PayloadTooLargeError,
	readRequestBody,
} from './security';

describe('security config', () => {
	test('requires a control token in production', () => {
		expect(() => createSecurityConfig({ NODE_ENV: 'production' })).toThrow(
			/INTERCEPTOR_CONTROL_TOKEN/,
		);
	});

	test('allows local origins in development', () => {
		const config = createSecurityConfig({ NODE_ENV: 'development' });
		expect(isAllowedOrigin('http://localhost:3000', config)).toBe(true);
		expect(isAllowedOrigin('https://example.com', config)).toBe(false);
	});

	test('checks bearer and header tokens', () => {
		const config = createSecurityConfig({
			NODE_ENV: 'production',
			INTERCEPTOR_CONTROL_TOKEN: 'secret-token',
		});

		expect(
			isAuthorizedRequest(
				new Request('http://localhost/api', {
					headers: { authorization: 'Bearer secret-token' },
				}),
				config,
			),
		).toBe(true);
		expect(
			isAuthorizedRequest(
				new Request('http://localhost/api', {
					headers: { [CONTROL_TOKEN_HEADER]: 'secret-token' },
				}),
				config,
			),
		).toBe(true);
		expect(isAuthorizedRequest(new Request('http://localhost/api'), config)).toBe(false);
	});
});

describe('readRequestBody', () => {
	test('rejects oversized bodies before buffering indefinitely', async () => {
		const request = Readable.from([Buffer.alloc(8)]) as Readable & {
			method?: string;
			destroy(): void;
		};
		request.method = 'POST';

		await expect(readRequestBody(request as never, 4)).rejects.toBeInstanceOf(PayloadTooLargeError);
	});
});
