import { toVectorLiteral, type Embedder } from "./embed.ts";
import { BadRequestError } from "./errors.ts";
import { DEFAULT_RRF_K, fuse, type Ranking } from "./rrf.ts";
import { assertIdentifier, type Sql } from "./sql.ts";

export type SearchMode = "hybrid" | "lexical" | "vector";

export interface SearchOptions {
  /** How many hits to return. */
  limit?: number | undefined;
  /** How deep each arm digs before the two are fused. */
  candidates?: number | undefined;
  /** Only consider documents whose metadata contains this object. */
  filter?: Record<string, unknown> | undefined;
  mode?: SearchMode | undefined;
  rrfK?: number | undefined;
}

export interface Hit {
  chunkId: number;
  documentId: number;
  externalId: string;
  title: string;
  source: string | null;
  position: number;
  text: string;
  start: number;
  end: number;
  /** Fused score. Comparable within one result set, not across queries. */
  score: number;
  /** Where each arm placed this chunk, one-based. Absent when an arm missed it. */
  ranks: Record<string, number>;
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  hits: Hit[];
  /** How many candidates each arm returned before fusion. */
  considered: Record<string, number>;
  tookMs: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_CANDIDATES = 50;
const MAX_CANDIDATES = 500;
const MAX_QUERY_CHARS = 1000;

interface Row {
  id: string;
}

/** Runs lexical and vector retrieval over the chunks table and fuses the two. */
export class Searcher {
  readonly #sql: Sql;
  readonly #embedder: Embedder;
  readonly #tsconfig: string;

  constructor(sql: Sql, embedder: Embedder, tsconfig = "english") {
    this.#sql = sql;
    this.#embedder = embedder;
    this.#tsconfig = assertIdentifier(tsconfig, "text search configuration");
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const started = performance.now();
    if (typeof query !== "string" || query.trim() === "") {
      throw new BadRequestError("query must be a non-empty string");
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw new BadRequestError(`query must be at most ${MAX_QUERY_CHARS} characters, got ${query.length}`);
    }
    const mode = options.mode ?? "hybrid";
    if (mode !== "hybrid" && mode !== "lexical" && mode !== "vector") {
      throw new BadRequestError(`mode must be hybrid, lexical or vector, got ${JSON.stringify(mode)}`);
    }
    const limit = bounded(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
    const candidates = bounded(options.candidates ?? DEFAULT_CANDIDATES, limit, MAX_CANDIDATES, "candidates");

    const rankings: Ranking[] = [];
    if (mode !== "vector") {
      rankings.push({ name: "lexical", ids: await this.#lexical(query, candidates, options.filter) });
    }
    if (mode !== "lexical") {
      rankings.push({ name: "vector", ids: await this.#vector(query, candidates, options.filter) });
    }

    const fused = fuse(rankings, options.rrfK ?? DEFAULT_RRF_K).slice(0, limit);
    const hits = await this.#hydrate(fused.map((entry) => entry.id));
    const byId = new Map(hits.map((hit) => [hit.chunkId, hit]));

    const considered: Record<string, number> = {};
    for (const ranking of rankings) considered[ranking.name] = ranking.ids.length;

    return {
      query,
      mode,
      hits: fused.flatMap((entry) => {
        const hit = byId.get(entry.id);
        return hit === undefined ? [] : [{ ...hit, score: entry.score, ranks: entry.ranks }];
      }),
      considered,
      tookMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }

  /**
   * Any-term matching, ranked.
   *
   * `plainto_tsquery` joins every word with AND, so one word the document
   * happens not to use drops it entirely. Stemming the query and then ORing
   * the lexemes lets `ts_rank_cd` do the deciding: documents that carry more
   * of the query, closer together, come first.
   */
  async #lexical(
    query: string,
    candidates: number,
    filter: Record<string, unknown> | undefined,
  ): Promise<number[]> {
    const params: unknown[] = [this.#tsconfig, query];
    const where = ["c.lexeme @@ q.tsq"];
    if (filter !== undefined) {
      params.push(JSON.stringify(filter));
      where.push(`d.metadata @> $${params.length}::jsonb`);
    }
    params.push(candidates);
    const { rows } = await this.#sql.query<Row>(
      `WITH q AS (
         SELECT COALESCE(
                  to_tsquery($1::regconfig,
                             NULLIF(array_to_string(tsvector_to_array(to_tsvector($1::regconfig, $2)), ' | '), '')),
                  plainto_tsquery($1::regconfig, '')
                ) AS tsq
       )
       SELECT c.id
         FROM chunks c
         JOIN documents d ON d.id = c.document_id,
              q
        WHERE ${where.join(" AND ")}
        ORDER BY ts_rank_cd(c.lexeme, q.tsq) DESC, c.id
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => Number(row.id));
  }

  async #vector(
    query: string,
    candidates: number,
    filter: Record<string, unknown> | undefined,
  ): Promise<number[]> {
    const [vector] = await this.#embedder.embed([query]);
    const params: unknown[] = [toVectorLiteral(vector as number[]), this.#embedder.id];
    const where = ["c.embedder = $2"];
    if (filter !== undefined) {
      params.push(JSON.stringify(filter));
      where.push(`d.metadata @> $${params.length}::jsonb`);
    }
    params.push(candidates);
    const { rows } = await this.#sql.query<Row>(
      `SELECT c.id
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.embedding <=> $1::vector, c.id
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => Number(row.id));
  }

  async #hydrate(ids: readonly number[]): Promise<Hit[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.#sql.query<{
      id: string;
      document_id: string;
      external_id: string;
      title: string;
      source: string | null;
      position: number;
      body: string;
      start_offset: number;
      end_offset: number;
    }>(
      `SELECT c.id, c.document_id, d.external_id, d.title, d.source,
              c.position, c.body, c.start_offset, c.end_offset
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.id = ANY($1::bigint[])`,
      [ids],
    );
    return rows.map((row) => ({
      chunkId: Number(row.id),
      documentId: Number(row.document_id),
      externalId: row.external_id,
      title: row.title,
      source: row.source,
      position: Number(row.position),
      text: row.body,
      start: Number(row.start_offset),
      end: Number(row.end_offset),
      score: 0,
      ranks: {},
    }));
  }
}

function bounded(value: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${what} must be an integer between ${min} and ${max}, got ${String(value)}`);
  }
  return value;
}
