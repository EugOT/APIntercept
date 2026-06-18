import type { InterceptorConfig } from '@interceptor/browser/shared/config';
import { BoardShopHeadersSchema, REQUIRED_HEADER_NAMES } from './types.js';

export const boardShopInterceptorConfig: InterceptorConfig = {
	domainName: 'boardshop',
	interceptPatterns: [
		'https://www.boardshop.example.com/**',
		'https://api.boardshop.example.com/**',
	],
	requiredHeaders: [...REQUIRED_HEADER_NAMES],
	headerSchema: BoardShopHeadersSchema,
	baseUrls: ['https://www.boardshop.example.com'],
	loginUrl: 'https://www.boardshop.example.com/login',
	accountUrl: 'https://www.boardshop.example.com/account',
	accountSelector: '[data-testid="account-name"]',
};
