/**
 * Remote browser streaming module exports.
 * @module browser/remote
 */

export { BrowserLifecycleManager } from './browser-manager.js';
export { browserLogger } from './logger.js';
export {
	cleanProfile,
	createProfile,
	deleteProfile,
	getOrCreateProfilePath,
	getProfilePath,
	getProfilesDir,
	listProfiles,
	type ProfileInfo,
	profileExists,
	validateProfileName,
} from './profiles.js';
export {
	connectBrowserRateLimiter,
	type FrameCallback,
	type FrameData,
	RemoteBrowserService,
	type StreamConfig,
} from './service.js';
