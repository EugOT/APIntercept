import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = 3002;
const IS_CI = !!process.env.CI;

export default defineConfig({
	testDir: './tests/e2e',
	outputDir: '/tmp/interceptor-test-results',
	fullyParallel: true,
	forbidOnly: IS_CI,
	retries: IS_CI ? 2 : 0,
	workers: IS_CI ? 1 : 2,
	// CRITICAL: HTML reporter blocks on failure (opens web server). Use 'list' in CI.
	reporter: IS_CI
		? 'list'
		: [['html', { open: 'never', outputFolder: '/tmp/interceptor-playwright-report' }]],
	timeout: 30_000,
	globalTimeout: IS_CI ? 10 * 60 * 1000 : 5 * 60 * 1000,

	expect: {
		timeout: 10_000,
	},

	use: {
		baseURL: `http://127.0.0.1:${E2E_PORT}`,
		trace: 'on-first-retry',
		actionTimeout: 15_000,
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],

	// Single webServer — Next.js handles both pages and API routes
	// IMPORTANT: Use `port` not `url` for readiness check — `url` can hang
	webServer: {
		command: `bun run --filter @interceptor/web dev --hostname 127.0.0.1 --port ${E2E_PORT}`,
		port: E2E_PORT,
		reuseExistingServer: !IS_CI,
		timeout: 120_000, // Next.js cold start can be slow
		stdout: 'ignore', // Prevent buffer blocking
		stderr: 'pipe',
		env: process.env,
	},
});
