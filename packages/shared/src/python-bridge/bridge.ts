/**
 * Python Bridge — IPC between Node.js and Python via stdin/stdout pipes.
 *
 * Spawns a Python worker as a child process and communicates using
 * JSON-RPC style messages. ~50-100x lower latency than HTTP for
 * local communication.
 *
 * @example
 * ```typescript
 * const bridge = new PythonBridge({
 *   workerPath: 'services/python/worker.py',
 * });
 * await bridge.start();
 * const result = await bridge.call<Stats>('compute', { numbers: [1, 2, 3] });
 * await bridge.stop();
 * ```
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { DEBUG } from '../debug.js';
import {
	BridgeError,
	type BridgeReadyMessage,
	type BridgeResponse,
	type PythonBridgeConfig,
} from './types.js';

function nonEmpty(value: string | undefined): string | undefined {
	return value && value.trim().length > 0 ? value : undefined;
}

const configuredPython =
	nonEmpty(process.env.INTERCEPTOR_PYTHON) ?? nonEmpty(process.env.PIXI_PYTHON);
const DEFAULTS = {
	pythonPath: configuredPython ?? 'pixi',
	pythonArgs: configuredPython ? [] : ['run', 'python'],
	timeoutMs: 5_000,
	startupTimeoutMs: configuredPython ? 5_000 : 10_000,
} as const;

export class PythonBridge {
	private process: ChildProcess | null = null;
	private readline: Interface | null = null;
	private availableMethods: string[] = [];

	private readonly config: Omit<PythonBridgeConfig, 'pythonArgs'> &
		Required<Pick<PythonBridgeConfig, 'pythonPath' | 'timeoutMs' | 'startupTimeoutMs'>> & {
			pythonArgs: string[];
		};

	/** Pending requests awaiting responses, keyed by request ID */
	private readonly pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();

	constructor(config: PythonBridgeConfig) {
		this.config = {
			pythonPath: config.pythonPath ?? DEFAULTS.pythonPath,
			pythonArgs: config.pythonArgs ?? DEFAULTS.pythonArgs,
			timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
			startupTimeoutMs: config.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs,
			...config,
		};
	}

	/** Start the Python worker process */
	async start(): Promise<void> {
		if (this.process) {
			throw new BridgeError('Bridge already started');
		}

		const workerPath = this.config.workerPath;
		// PYTHONPATH = parent of parent of worker.py (e.g., services/python)
		const pythonPath = dirname(dirname(workerPath));

		DEBUG('PythonBridge.start', 'spawning worker', () => ({ workerPath }));

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.cleanup();
				reject(new BridgeError('Worker startup timeout', -32000));
			}, this.config.startupTimeoutMs);

			// -u flag: unbuffered stdout — without it, responses may buffer indefinitely
			const env = {
				...globalThis.process.env,
				PYTHONUNBUFFERED: '1',
				PYTHONPATH: pythonPath,
			};
			this.process = spawn(this.config.pythonPath, [...this.config.pythonArgs, '-u', workerPath], {
				cwd: pythonPath,
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			this.process.on('error', (err: Error) => {
				clearTimeout(timeout);
				this.cleanup();
				reject(new BridgeError(`Failed to start worker: ${err.message}`));
			});

			this.process.on('exit', () => {
				this.cleanup();
			});

			// Stderr → console (never touches the RPC channel).
			// Python's DEBUG() writes to the log file directly — no relay needed.
			this.process.stderr?.on('data', (data: Buffer) => {
				const msg = data.toString().trim();
				if (msg) {
					console.error(`[python-bridge:stderr] ${msg}`);
				}
			});

			const stdout = this.process.stdout;
			if (!stdout) {
				clearTimeout(timeout);
				reject(new BridgeError('Process stdout not available'));
				return;
			}

			this.readline = createInterface({
				input: stdout,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			this.readline.on('line', (line: string) => {
				this.handleMessage(line);
			});

			// Wait for the ready handshake before resolving
			const onReady = (rawLine: string) => {
				try {
					const msg = JSON.parse(rawLine.trim()) as BridgeReadyMessage;
					if (msg.type === 'ready') {
						clearTimeout(timeout);
						this.availableMethods = msg.methods;
						DEBUG('PythonBridge.start', 'worker ready', () => ({
							methods: msg.methods,
						}));
						resolve();
					}
				} catch {
					// Not JSON or not the ready message — ignore
				}
			};

			this.readline.once('line', onReady);
		});
	}

	/** Stop the Python worker process */
	async stop(): Promise<void> {
		const proc = this.process;
		if (!proc) return;

		DEBUG('PythonBridge.stop', 'stopping worker');

		// Reject all pending requests
		for (const [id, pending] of this.pending) {
			pending.reject(new BridgeError('Bridge stopped'));
			this.pending.delete(id);
		}

		// Close stdin — the worker exits when stdin reaches EOF
		proc.stdin?.end();

		return new Promise((resolve) => {
			let resolved = false;
			const done = () => {
				if (resolved) return;
				resolved = true;
				clearTimeout(forceKill);
				this.cleanup();
				resolve();
			};

			const forceKill = setTimeout(() => {
				try {
					proc.kill('SIGKILL');
				} catch {
					// Already exited
				}
				done();
			}, 1000);

			proc.once('exit', done);
		});
	}

	/** Call a Python method and return the typed result */
	async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (!this.process?.stdin) {
			throw new BridgeError('Bridge not started');
		}

		const id = randomUUID();

		DEBUG('PythonBridge.call', `method="${method}"`, () => ({
			paramKeys: Object.keys(params),
		}));

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new BridgeError(`Request timeout after ${this.config.timeoutMs}ms`, -32001));
			}, this.config.timeoutMs);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			const line = `${JSON.stringify({ id, method, params })}\n`;
			this.process?.stdin?.write(line, (err: Error | null | undefined) => {
				if (err) {
					this.pending.delete(id);
					clearTimeout(timeout);
					reject(new BridgeError(`Failed to send request: ${err.message}`));
				}
			});
		});
	}

	/** Check if the worker process is alive */
	isConnected(): boolean {
		return this.process !== null && !this.process.killed && this.process.exitCode === null;
	}

	/** Get the methods the worker advertised in its ready message */
	getAvailableMethods(): string[] {
		return [...this.availableMethods];
	}

	/** Parse a JSON-RPC response and resolve/reject the matching pending request */
	protected handleMessage(rawLine: string): void {
		const line = rawLine.trim();
		if (!line) return;

		try {
			const response = JSON.parse(line) as BridgeResponse;

			// Skip non-response messages (like ready)
			if (!('id' in response)) return;

			const pending = this.pending.get(response.id);
			if (!pending) return;

			this.pending.delete(response.id);

			if (response.error) {
				pending.reject(new BridgeError(response.error.message, response.error.code));
			} else {
				pending.resolve(response.result);
			}
		} catch {
			// Not valid JSON — ignore
		}
	}

	private cleanup(): void {
		if (this.readline) {
			this.readline.close();
			this.readline = null;
		}
		this.process = null;
	}
}
