/**
 * Text embeddings for schema search, with two interchangeable providers:
 *
 *   local   - all-MiniLM-L6-v2 run inside Node.js (transformers.js). No key or
 *             network after a one-time ~25 MB download. Used for the public demo.
 *   gateway - text-embedding-3-small through an OpenAI-compatible gateway,
 *             for networks that block the model download.
 *
 * Both produce 384-dimension, unit-length vectors, so they fit the same
 * pgvector column. Vectors from different models are NOT comparable: the
 * indexer includes the embedder id in its change hash, so switching provider
 * re-embeds every table.
 */
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';

export const EMBEDDING_DIMENSIONS = 384;

export interface Embedder {
  /** Identifies the model; stored indirectly so a provider switch forces a re-index. */
  readonly id: string;
  /** Returns one vector per input text, in the same order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function createEmbedder(config: Config): Embedder {
  if (config.ASKDB_EMBEDDINGS === 'gateway') {
    // config validation guarantees a base URL when the gateway is selected.
    return new GatewayEmbedder(config.ASKDB_ANTHROPIC_BASE_URL as string, config.ANTHROPIC_API_KEY);
  }
  return new LocalEmbedder();
}

/** pgvector's text format: [0.1,0.2,...] */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

class LocalEmbedder implements Embedder {
  private static readonly MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
  readonly id = `local:${LocalEmbedder.MODEL_ID}`;
  private extractor: Promise<(texts: string[], options: object) => Promise<{ tolist(): unknown }>> | undefined;

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.extractor ??= this.load();
    const output = await (await this.extractor)([...texts], { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  }

  // Imported lazily so the gateway provider never loads the ONNX runtime.
  private async load() {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = fileURLToPath(new URL('../../../.cache/models', import.meta.url));
    return pipeline('feature-extraction', LocalEmbedder.MODEL_ID, { dtype: 'fp32' }) as unknown as Promise<
      (texts: string[], options: object) => Promise<{ tolist(): unknown }>
    >;
  }
}

class GatewayEmbedder implements Embedder {
  private static readonly MODEL_ID = 'text-embedding-3-small';
  readonly id = `gateway:${GatewayEmbedder.MODEL_ID}@${EMBEDDING_DIMENSIONS}`;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(new URL('/v1/embeddings', this.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GatewayEmbedder.MODEL_ID, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error('Embedding response did not match the request');
    }
    return vectors;
  }
}
