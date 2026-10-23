import { HttpEmbedder, NgramEmbedder, type Embedder } from "./embed.ts";
import { ConfigError } from "./errors.ts";
import type { ChunkOptions } from "./chunk.ts";

export interface Config {
  databaseUrl: string;
  port: number;
  token: string | undefined;
  tsconfig: string;
  embedder: Embedder;
  chunk: ChunkOptions;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new ConfigError(`${name} is not set`);
  return value;
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return value;
}

function embedderFrom(env: Env): Embedder {
  const kind = env.EMBEDDER ?? "ngram";
  if (kind === "ngram") return new NgramEmbedder(integer(env, "EMBED_DIMENSIONS", 256));
  if (kind === "http") {
    return new HttpEmbedder({
      url: required(env, "EMBED_URL"),
      model: required(env, "EMBED_MODEL"),
      dimensions: integer(env, "EMBED_DIMENSIONS", 1536),
      apiKey: env.EMBED_API_KEY,
    });
  }
  throw new ConfigError(`EMBEDDER must be ngram or http, got ${JSON.stringify(kind)}`);
}

/** Reads the whole configuration out of the environment, failing loudly on anything missing. */
export function readConfig(env: Env = process.env): Config {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    port: integer(env, "PORT", 8080),
    token: env.DOCSEARCH_TOKEN,
    tsconfig: env.TEXT_SEARCH_CONFIG ?? "english",
    embedder: embedderFrom(env),
    chunk: {
      maxChars: integer(env, "CHUNK_MAX_CHARS", 900),
      overlapChars: integer(env, "CHUNK_OVERLAP_CHARS", 150),
    },
  };
}
