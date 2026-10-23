import { ConfigError, EmbeddingError } from "./errors.ts";

/** Turns text into vectors. One call may carry many texts. */
export interface Embedder {
  /** Length of every vector this embedder returns. */
  readonly dimensions: number;
  /** Short name recorded alongside stored vectors, so a mismatch is visible. */
  readonly id: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

const DEFAULT_DIMENSIONS = 256;
const NGRAM_SIZE = 3;

function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return vector;
  const length = Math.sqrt(sum);
  return vector.map((value) => value / length);
}

/** FNV-1a, 32 bit. Stable across runs and machines, which is what matters here. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function foldCase(text: string): string {
  return text.toLocaleLowerCase("sv-SE").replace(/\s+/g, " ").trim();
}

/**
 * Hashes character n-grams into a fixed-width vector.
 *
 * This is not a semantic model and does not pretend to be one. What it buys is
 * a second opinion that survives what exact term matching trips over: a typo, a
 * compound written as two words, an inflected ending. It needs no network, no
 * key and no warm-up, so tests and the eval run anywhere.
 */
export class NgramEmbedder implements Embedder {
  readonly dimensions: number;
  readonly id: string;

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    if (!Number.isInteger(dimensions) || dimensions < 8) {
      throw new ConfigError(`dimensions must be an integer of at least 8, got ${String(dimensions)}`);
    }
    this.dimensions = dimensions;
    this.id = `ngram-${NGRAM_SIZE}-${dimensions}`;
  }

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.one(text)));
  }

  private one(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const padded = ` ${foldCase(text)} `;
    for (let i = 0; i + NGRAM_SIZE <= padded.length; i += 1) {
      const gram = padded.slice(i, i + NGRAM_SIZE);
      const h = hash(gram);
      const bucket = h % this.dimensions;
      const sign = (h >>> 31) === 0 ? 1 : -1;
      vector[bucket] = (vector[bucket] as number) + sign;
    }
    return normalize(vector);
  }
}

export interface HttpEmbedderOptions {
  /** Full URL of an OpenAI-compatible embeddings endpoint. */
  url: string;
  model: string;
  dimensions: number;
  apiKey?: string | undefined;
  /** Injected so tests do not need a network. */
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Calls any embeddings endpoint that speaks the OpenAI request and response shape. */
export class HttpEmbedder implements Embedder {
  readonly dimensions: number;
  readonly id: string;
  readonly #options: {
    url: string;
    model: string;
    dimensions: number;
    apiKey: string | undefined;
    fetch: typeof globalThis.fetch;
    timeoutMs: number;
  };

  constructor(options: HttpEmbedderOptions) {
    if (!/^https?:\/\//.test(options.url)) {
      throw new ConfigError(`embedder url must be http or https, got ${options.url}`);
    }
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new ConfigError(`dimensions must be a positive integer, got ${String(options.dimensions)}`);
    }
    this.dimensions = options.dimensions;
    this.id = options.model;
    this.#options = {
      url: options.url,
      model: options.model,
      dimensions: options.dimensions,
      apiKey: options.apiKey,
      fetch: options.fetch ?? globalThis.fetch,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { url, model, apiKey, fetch, timeoutMs } = this.#options;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: [...texts] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new EmbeddingError(`embeddings endpoint answered ${response.status} ${response.statusText}`);
    }

    const body: unknown = await response.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbeddingError(`expected ${texts.length} vectors back, got ${Array.isArray(data) ? data.length : "none"}`);
    }
    return data.map((entry, i) => {
      const vector = (entry as { embedding?: unknown }).embedding;
      if (!Array.isArray(vector) || vector.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        throw new EmbeddingError(`vector ${i} is not a list of finite numbers`);
      }
      if (vector.length !== this.dimensions) {
        throw new EmbeddingError(`vector ${i} has ${vector.length} dimensions, expected ${this.dimensions}`);
      }
      return vector as number[];
    });
  }
}

/** Formats a vector the way pgvector parses it. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
