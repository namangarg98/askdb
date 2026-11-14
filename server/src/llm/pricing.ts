import type { TokenUsage } from './usage.js';

/**
 * USD per million tokens, first-party Anthropic list prices (checked 2026-10).
 * Used only for the cost estimate shown in the CLI and the eval report.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const inputCost =
    usage.inputTokens * price.input +
    usage.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * price.input * CACHE_READ_MULTIPLIER;
  return (inputCost + usage.outputTokens * price.output) / 1_000_000;
}
