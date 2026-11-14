import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Claude client configured only from AskDB's own settings. Every option is set
 * explicitly so the SDK never falls back to unrelated ANTHROPIC_* variables
 * from the shell (for example a work gateway token).
 */
export function createClaudeClient(config: Config): Anthropic {
  const usesGateway = config.ASKDB_ANTHROPIC_BASE_URL !== undefined;

  return new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    authToken: null,
    baseURL: config.ASKDB_ANTHROPIC_BASE_URL ?? ANTHROPIC_DEFAULT_BASE_URL,
    // A gateway sets the API version for whichever provider it routes to. Our
    // own `anthropic-version` header can conflict with that route (seen as a
    // 400 "different API versions" via the Vertex route), so let the gateway
    // decide. Direct calls to api.anthropic.com keep the SDK's header.
    ...(usesGateway ? { defaultHeaders: { 'anthropic-version': null } } : {}),
  });
}
