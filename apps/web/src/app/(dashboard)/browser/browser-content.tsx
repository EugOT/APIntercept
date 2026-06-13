'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Omnibar } from '@/components/browser/omnibar';
import {
	RemoteBrowserViewer,
	type RemoteBrowserViewerHandle,
} from '@/components/browser/remote-viewer';
import { Button } from '@/components/ui/button';
import { withWebSocketTicket } from '@/lib/control-auth';

type ConnectionStatus = 'connecting' | 'connected' | 'ready' | 'disconnected' | 'error';

/** Domain verification data from interceptors */
interface DomainInfo {
	domain?: string;
	accountNumber?: string;
	firstName?: string;
	lastName?: string;
	buyingPower?: string;
	error?: string;
}

export default function BrowserContent() {
	const searchParams = useSearchParams();
	const [status, setStatus] = useState<ConnectionStatus>('disconnected');
	const [url, setUrl] = useState('');
	const [frameCount, setFrameCount] = useState(0);
	const [domainInfo, setDomainInfo] = useState<DomainInfo | null>(null);
	const [warmingUp, setWarmingUp] = useState(false);
	const [wsUrl, setWsUrl] = useState('');
	const wsRef = useRef<WebSocket | null>(null);
	const viewerRef = useRef<RemoteBrowserViewerHandle | null>(null);

	// Build WebSocket URL from search params — supports any domain
	// Usage: /browser?profile=example&capture=example.com&url=https://example.com
	const baseWsUrl = useMemo(() => {
		if (typeof window === 'undefined') return '';
		const params = new URLSearchParams();
		const profile = searchParams.get('profile') || 'generic';
		const capture = searchParams.get('capture') || '';
		const startUrl = searchParams.get('url') || '';
		params.set('profile', profile);
		if (capture) params.set('capture', capture);
		if (startUrl) params.set('url', startUrl);
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${window.location.host}/browser/stream?${params.toString()}`;
	}, [searchParams]);

	useEffect(() => {
		if (!baseWsUrl) return;
		let cancelled = false;

		withWebSocketTicket(baseWsUrl).then((urlWithTicket) => {
			if (!cancelled) setWsUrl(urlWithTicket);
		});

		return () => {
			cancelled = true;
		};
	}, [baseWsUrl]);

	const handleWsRef = useCallback((ws: WebSocket | null) => {
		wsRef.current = ws;
	}, []);

	const handleUrlChange = useCallback((newUrl: string) => {
		if (newUrl.startsWith('data:') || newUrl === 'about:blank') return;
		setUrl(newUrl);
	}, []);

	const sendMessage = useCallback((message: object) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(message));
		}
	}, []);

	// Navigation handlers
	const handleNavigate = useCallback(
		(targetUrl: string) => {
			setUrl(targetUrl);
			sendMessage({ type: 'navigate', url: targetUrl });
		},
		[sendMessage],
	);

	const handleBack = useCallback(() => sendMessage({ type: 'back' }), [sendMessage]);
	const handleForward = useCallback(() => sendMessage({ type: 'forward' }), [sendMessage]);
	const handleReload = useCallback(() => sendMessage({ type: 'reload' }), [sendMessage]);
	const handleHome = useCallback(() => {
		setUrl('');
		sendMessage({ type: 'navigate', url: 'about:blank' });
	}, [sendMessage]);

	// Warmup — visit a few sites to build browsing history
	const handleWarmup = useCallback(() => {
		setWarmingUp(true);
		sendMessage({ type: 'warmup', sites: 3, delay: 2000 });
	}, [sendMessage]);

	// Connect/disconnect
	const handleConnect = useCallback(() => {
		setDomainInfo(null);
		viewerRef.current?.connect();
	}, []);

	const handleDisconnect = useCallback(() => {
		viewerRef.current?.disconnect();
	}, []);

	const handleConnectRef = useCallback((handle: RemoteBrowserViewerHandle) => {
		viewerRef.current = handle;
	}, []);

	// Handle messages from the browser stream — generic for any domain
	const handleMessage = useCallback((message: { type: string; [key: string]: unknown }) => {
		if (message.type.endsWith('_verified')) {
			setDomainInfo({
				domain: message.type.replace('_verified', ''),
				accountNumber: message.accountNumber as string,
				firstName: message.firstName as string,
				lastName: message.lastName as string,
				buyingPower: message.buyingPower as string,
			});
		} else if (message.type.endsWith('_verification_failed')) {
			setDomainInfo({
				domain: message.type.replace('_verification_failed', ''),
				error: message.error as string,
			});
		} else if (message.type.endsWith('_login_page_detected')) {
			setDomainInfo(null);
		} else if (message.type === 'warmup_complete') {
			setWarmingUp(false);
		}
	}, []);

	const isReady = status === 'ready';
	const isConnected = status === 'connected' || status === 'ready';

	return (
		<div className="flex flex-1 flex-col">
			{/* Top bar: connection controls + Robinhood status */}
			<div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2">
				<Button
					onClick={isConnected ? handleDisconnect : handleConnect}
					variant={isConnected ? 'destructive' : 'default'}
					size="sm"
				>
					{isConnected ? 'Disconnect' : 'Connect'}
				</Button>

				{isReady && (
					<Button onClick={handleWarmup} variant="outline" size="sm" disabled={warmingUp}>
						{warmingUp ? 'Warming up...' : 'Warmup'}
					</Button>
				)}

				<span className="text-xs text-muted-foreground">
					{status === 'disconnected' && 'Not connected'}
					{status === 'connecting' && 'Connecting...'}
					{status === 'connected' && 'Starting browser...'}
					{status === 'ready' &&
						(warmingUp ? 'Building browsing history...' : `Browser ready (${frameCount} frames)`)}
					{status === 'error' && 'Connection error'}
				</span>

				{/* Domain verification status */}
				{domainInfo && !domainInfo.error && (
					<span className="ml-auto rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
						{domainInfo.domain}: {domainInfo.firstName || domainInfo.accountNumber || 'verified'}
						{domainInfo.buyingPower &&
							` — $${Number(domainInfo.buyingPower).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
					</span>
				)}
				{domainInfo?.error && (
					<span className="ml-auto rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400">
						Auth failed: {domainInfo.error}
					</span>
				)}
			</div>

			{/* Omnibar */}
			<Omnibar
				url={url}
				onUrlChange={setUrl}
				onNavigate={handleNavigate}
				onBack={handleBack}
				onForward={handleForward}
				onReload={handleReload}
				onHome={handleHome}
				disabled={!isReady}
				status={status}
			/>

			{/* Browser canvas — fills remaining space */}
			<div className="flex-1 overflow-hidden bg-muted">
				{wsUrl && (
					<RemoteBrowserViewer
						key={wsUrl}
						wsUrl={wsUrl}
						width={1024}
						height={576}
						onStatusChange={setStatus}
						onWsRef={handleWsRef}
						onFrameCount={setFrameCount}
						onUrl={handleUrlChange}
						onMessage={handleMessage}
						autoConnect={true}
						onConnectRef={handleConnectRef}
						className="flex h-full items-center justify-center p-4"
					/>
				)}
			</div>
		</div>
	);
}
