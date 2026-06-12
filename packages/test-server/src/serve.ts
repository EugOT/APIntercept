/**
 * Standalone test server entry point.
 * Run: bun run --filter @interceptor/test-server start
 */

import { createTestServer } from './index';

const port = Number(process.env.TEST_SERVER_PORT) || 4444;

const server = await createTestServer({ port });

console.log(`Test server running at ${server.url}`);
console.log('Sites:');
console.log(`  boardshop:  ${server.url}/sites/boardshop/`);
console.log(`  liveboard:  ${server.url}/sites/liveboard/`);
console.log(`  streamshop: ${server.url}/sites/streamshop/`);
console.log(`  databoard:  ${server.url}/sites/databoard/`);

process.on('SIGINT', async () => {
	await server.close();
	process.exit(0);
});
