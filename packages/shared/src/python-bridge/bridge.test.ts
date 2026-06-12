import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PythonBridge } from './bridge';
import { BridgeError } from './types';

const WORKER_PATH = resolve(__dirname, '../../../../services/python/worker.py');

vi.setConfig({ testTimeout: 15_000 });

describe('PythonBridge', () => {
	let bridge: PythonBridge;

	afterEach(async () => {
		if (bridge?.isConnected()) {
			await bridge.stop();
		}
	});

	it('starts, receives ready handshake, and reports methods', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH });
		await bridge.start();

		expect(bridge.isConnected()).toBe(true);
		expect(bridge.getAvailableMethods()).toEqual(['health', 'compute', 'classify_headlines']);
	});

	it('calls health and gets a response', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH });
		await bridge.start();

		const result = await bridge.call<{
			status: string;
			service: string;
			version: string;
		}>('health');

		expect(result.status).toBe('ok');
		expect(result.service).toBe('python-worker');
		expect(result.version).toBe('1.0.0');
	});

	it('calls compute with known inputs', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH });
		await bridge.start();

		const result = await bridge.call<{
			mean: number;
			median: number;
			stdev: number;
			min: number;
			max: number;
			count: number;
		}>('compute', { numbers: [2, 4, 6, 8, 10] });

		expect(result.mean).toBe(6);
		expect(result.median).toBe(6);
		expect(result.min).toBe(2);
		expect(result.max).toBe(10);
		expect(result.count).toBe(5);
		expect(result.stdev).toBeCloseTo(3.162, 2);
	});

	it('rejects unknown methods with BridgeError', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH });
		await bridge.start();

		await expect(bridge.call('nonexistent')).rejects.toThrow(BridgeError);
		await expect(bridge.call('nonexistent')).rejects.toThrow('Unknown method: nonexistent');
	});

	it('rejects pending requests when bridge is stopped', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH, timeoutMs: 10000 });
		await bridge.start();

		// Attach catch handler BEFORE stopping to prevent unhandled rejection
		const promise = bridge.call('health').catch((e: Error) => e);
		await bridge.stop();

		const error = await promise;
		expect(error).toBeInstanceOf(BridgeError);
		expect((error as Error).message).toBe('Bridge stopped');
	});

	it('reports isConnected correctly through lifecycle', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH });

		expect(bridge.isConnected()).toBe(false);

		await bridge.start();
		expect(bridge.isConnected()).toBe(true);

		await bridge.stop();
		expect(bridge.isConnected()).toBe(false);
	});

	it('throws if call is made before start', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH });

		await expect(bridge.call('health')).rejects.toThrow('Bridge not started');
	});

	it('throws if started twice', async () => {
		bridge = new PythonBridge({ workerPath: WORKER_PATH });
		await bridge.start();

		await expect(bridge.start()).rejects.toThrow('Bridge already started');
	});
});
