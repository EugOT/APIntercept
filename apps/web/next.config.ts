import { resolve } from 'node:path';
import * as dotenv from 'dotenv';
import type { NextConfig } from 'next';

// Load root .env so monorepo-wide vars are available
dotenv.config({ path: resolve(import.meta.dirname, '../../.env') });

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

const nextConfig: NextConfig = {
	output: 'standalone',
	outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
	transpilePackages: ['@interceptor/shared'],

	// Proxy /api/* and /browser/* to the Hono API server
	// INTERCEPTOR_API_URL should be http://api:3001 inside Docker Compose.
	// Dashboard components call relative URLs — no CORS issues
	async rewrites() {
		const apiUrl = trimTrailingSlash(
			process.env.INTERCEPTOR_API_URL ??
				process.env.API_URL ??
				`http://localhost:${process.env.API_PORT ?? '3001'}`,
		);
		return [
			{
				source: '/api/:path*',
				destination: `${apiUrl}/api/:path*`,
			},
			{
				source: '/browser/:path*',
				destination: `${apiUrl}/browser/:path*`,
			},
		];
	},
};

export default nextConfig;
