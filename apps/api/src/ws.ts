import { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import { getBridge } from './bridge.js';
import {
	addClient,
	getState,
	removeClient,
	resetState,
	setMultiplier,
	setRunning,
	type WsClient,
} from './state.js';

type InboundMessage =
	| { type: 'increment' }
	| { type: 'decrement' }
	| { type: 'set'; value: number }
	| { type: 'pause' }
	| { type: 'play' }
	| { type: 'reset' }
	| { type: 'compute'; requestId: string; numbers: number[] };

export function createWsApp(upgradeWebSocket: UpgradeWebSocket): Hono {
	const app = new Hono();

	app.get(
		'/ws',
		upgradeWebSocket(() => ({
			onOpen(_event: Event, ws: WSContext) {
				const client = addClient(ws);
				// Store client reference for cleanup on close
				(ws as unknown as { __client: WsClient }).__client = client;
			},

			onMessage(event: MessageEvent, ws: WSContext) {
				let msg: InboundMessage;
				try {
					msg = JSON.parse(event.data as string);
				} catch {
					return;
				}

				const state = getState();

				switch (msg.type) {
					case 'increment':
						setMultiplier(state.multiplier + 1);
						break;
					case 'decrement':
						setMultiplier(state.multiplier - 1);
						break;
					case 'set':
						if (typeof msg.value === 'number') setMultiplier(msg.value);
						break;
					case 'pause':
						setRunning(false);
						break;
					case 'play':
						setRunning(true);
						break;
					case 'reset':
						resetState();
						break;
					case 'compute':
						handleCompute(ws, msg.requestId, msg.numbers);
						break;
				}
			},

			onClose(_event: Event, ws: WSContext) {
				const client = (ws as unknown as { __client?: WsClient }).__client;
				if (client) removeClient(client);
			},
		})),
	);

	return app;
}

async function handleCompute(ws: WSContext, requestId: string, numbers: number[]): Promise<void> {
	if (!Array.isArray(numbers) || numbers.length < 2) {
		ws.send(
			JSON.stringify({
				type: 'compute:error',
				requestId,
				error: 'Need at least 2 numbers.',
			}),
		);
		return;
	}

	try {
		const bridge = await getBridge();
		const result = await bridge.call('compute', { numbers });
		ws.send(
			JSON.stringify({
				type: 'compute:result',
				requestId,
				data: result,
			}),
		);
	} catch (err) {
		ws.send(
			JSON.stringify({
				type: 'compute:error',
				requestId,
				error: (err as Error).message,
			}),
		);
	}
}
