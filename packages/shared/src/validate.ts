import type { AppConfig } from './types.js';

const VALID_ENVIRONMENTS = ['development', 'production', 'test'] as const;

export class ConfigValidationError extends Error {
	constructor(
		public readonly field: string,
		message: string,
	) {
		super(message);
		this.name = 'ConfigValidationError';
	}
}

export function validateConfig(input: unknown): AppConfig {
	if (input === null || input === undefined || typeof input !== 'object') {
		throw new ConfigValidationError('root', 'Config must be a non-null object');
	}

	const obj = input as Record<string, unknown>;

	if (typeof obj.name !== 'string' || obj.name.trim() === '') {
		throw new ConfigValidationError('name', 'name must be a non-empty string');
	}

	if (typeof obj.version !== 'string' || obj.version.trim() === '') {
		throw new ConfigValidationError('version', 'version must be a non-empty string');
	}

	if (
		typeof obj.environment !== 'string' ||
		!VALID_ENVIRONMENTS.includes(obj.environment as (typeof VALID_ENVIRONMENTS)[number])
	) {
		throw new ConfigValidationError(
			'environment',
			`environment must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
		);
	}

	return {
		name: obj.name,
		version: obj.version,
		environment: obj.environment as AppConfig['environment'],
	};
}
