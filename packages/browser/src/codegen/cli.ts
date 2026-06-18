#!/usr/bin/env bun

/**
 * API Client Code Generator CLI
 *
 * Usage: bun run --filter @interceptor/browser codegen <domain> --output <path>
 *
 * Examples:
 * - bun run --filter @interceptor/browser codegen boardshop
 * - bun run --filter @interceptor/browser codegen boardshop --output ./generated/boardshop-client.ts
 * - bun run --filter @interceptor/browser codegen deckmarket --server http://localhost:3001
 *
 * @module browser/codegen/cli
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDomain } from '../handler/domain-loader.js';
import { type ClientGenerationConfig, generateClientFile } from './client-codegen.js';
import { inferRequestSchema, inferResponseSchema } from './schema-inferencer.js';
import { analyzeTraffic, summarizePatterns } from './traffic-analyzer.js';

/**
 * Parse command-line arguments.
 */
function parseArgs(args: string[]): {
	domain: string;
	outputPath: string;
	trafficPath?: string;
	verbose: boolean;
} {
	const domain = args[0];
	if (!domain) {
		console.error(
			'Usage: bun run --filter @interceptor/browser codegen <domain> [--output path] [--traffic path] [--verbose]',
		);
		process.exit(1);
	}

	let outputPath = `./generated/${domain}-api-client.ts`;
	let trafficPath: string | undefined;
	let verbose = false;

	for (let i = 1; i < args.length; i++) {
		if (args[i] === '--output' && args[i + 1]) {
			outputPath = args[++i];
		} else if (args[i] === '--traffic' && args[i + 1]) {
			trafficPath = args[++i];
		} else if (args[i] === '--verbose') {
			verbose = true;
		}
	}

	return { domain, outputPath, trafficPath, verbose };
}

/**
 * Main CLI entry point.
 */
async function main() {
	const { domain, outputPath, trafficPath, verbose } = parseArgs(process.argv.slice(2));

	console.log(`\n🔍 Generating API client for domain: ${domain}\n`);

	// 1. Get domain plugin if registered, or use minimal defaults for ad-hoc discovery
	const plugin = getDomain(domain);
	const domainConfig = plugin?.config || {
		domainName: domain,
		interceptPatterns: [],
		requiredHeaders: [],
		// biome-ignore lint/suspicious/noExplicitAny: empty schema placeholder for codegen
		headerSchema: {} as any,
		baseUrls: [],
	};

	// 2. Load traffic data
	// biome-ignore lint/suspicious/noExplicitAny: traffic shape comes from JSON file, validated at runtime
	let traffic: { entries: any[] } = { entries: [] };

	if (trafficPath) {
		try {
			const content = readFileSync(trafficPath, 'utf-8');
			traffic = JSON.parse(content);
			console.log(`✅ Loaded traffic from ${trafficPath} (${traffic.entries.length} entries)`);
		} catch (err) {
			console.error(`❌ Failed to load traffic from ${trafficPath}:`, err);
			process.exit(1);
		}
	} else {
		// Try to fetch from live server
		try {
			const response = await fetch('http://localhost:3001/browser/traffic');
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			traffic = await response.json();
			console.log(`✅ Fetched traffic from server (${traffic.entries.length} entries)`);
		} catch (err) {
			console.warn(
				`⚠️  Could not fetch traffic from server: ${err instanceof Error ? err.message : String(err)}`,
			);
			console.warn('Using empty traffic. Provide --traffic <path> for a traffic JSON file.');
		}
	}

	// 3. Analyze traffic
	console.log(`\n📊 Analyzing traffic...\n`);
	const patterns = analyzeTraffic(traffic.entries || []);

	if (patterns.length === 0) {
		console.warn('⚠️  No valid traffic patterns found');
		process.exit(1);
	}

	console.log(summarizePatterns(patterns));

	const readyPatterns = patterns.filter((p) => p.canInferSchema);
	if (readyPatterns.length === 0) {
		console.warn('\n⚠️  No endpoints have enough examples (≥3) to infer schemas');
		process.exit(1);
	}

	// 4. Infer schemas
	console.log(`\n📝 Inferring schemas for ${readyPatterns.length} endpoints...\n`);

	const endpoints = readyPatterns.map((pattern) => ({
		...pattern,
		requestSchema: inferRequestSchema(pattern.examples.map((ex) => ex.requestBody)),
		responseSchema: inferResponseSchema(pattern.examples.map((ex) => ex.responseBody)),
	}));

	if (verbose) {
		console.log('Schemas inferred:');
		for (const ep of endpoints) {
			console.log(`  ${ep.method} ${ep.pattern}`);
		}
	}

	// 5. Generate client
	console.log(`\n🛠️  Generating client code...\n`);

	const className = `${domain.charAt(0).toUpperCase() + domain.slice(1)}ApiClient`;
	const clientConfig: ClientGenerationConfig = {
		domainName: domain,
		className,
		baseUrls: domainConfig.baseUrls || [],
		requiredHeaders: domainConfig.requiredHeaders,
		// biome-ignore lint/suspicious/noExplicitAny: codegen endpoint shape varies
		endpoints: endpoints as any,
	};

	const clientCode = generateClientFile(clientConfig);

	// 6. Write to file
	try {
		const fullPath = resolve(outputPath);
		writeFileSync(fullPath, clientCode, 'utf-8');
		console.log(`✅ Generated client: ${fullPath}`);
		console.log(`\n   Class: ${className}`);
		console.log(`   Methods: ${endpoints.length}`);
		console.log(`   Base URLs: ${domainConfig.baseUrls?.join(', ') || 'N/A'}`);
	} catch (err) {
		console.error(`❌ Failed to write client file:`, err);
		process.exit(1);
	}

	console.log(`\n✨ Done! You can now import and use:\n`);
	console.log(`   import { create${className.replace(/Client$/, '')} } from '${outputPath}';`);
	console.log(`   const client = create${className.replace(/Client$/, '')}(headers);\n`);
}

// Run CLI
main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
