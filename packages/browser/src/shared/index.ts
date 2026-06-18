/**
 * @interceptor/browser/shared — Generic domain-agnostic classes
 *
 * Shared base classes for multi-domain support:
 * - GenericInterceptor: Base class for all domain interceptors
 * - GenericSessionManager: Centralized session/header management
 * - Shared types and configs
 *
 * @module browser/shared
 */

export {
	classifyEntry,
	classifyPage,
	type EncodingType,
	type PageClassification,
	type TrafficClassification,
	type TrafficEntry,
	type TransportType,
} from './classify-transport.js';
export type { InterceptorConfig, VerificationResult } from './config.js';
export { GenericInterceptor } from './interceptor.js';
export { GenericSessionManager } from './session-manager.js';
export type {
	InterceptedRequest,
	InterceptedResponse,
	InterceptionCallback,
	SessionStatus,
} from './types.js';
