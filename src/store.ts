import { chunk, type ChunkOptions } from "./chunk.ts";
import { toVectorLiteral, type Embedder } from "./embed.ts";
import { BadRequestError } from "./errors.ts";
import type { Sql } from "./sql.ts";

export interface DocumentInput {
  /** Your own identifier. Ingesting the same one again replaces the document. */
  id: string;
  title: string;
  body: string;
  source?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface IngestResult {
  documentId: number;
  externalId: string;
  chunks: number;
  /** True when a document with this id was already stored. */
  replaced: boolean;
}

export interface StoredDocument {
  documentId: number;
  externalId: string;
  title: string;
  source: string | null;
  metadata: Record<string, unknown>;
  chunks: number;
}

const MAX_TITLE_CHARS = 500;
const MAX_BODY_CHARS = 2_000_000;

function validate(input: DocumentInput): void {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new BadRequestError("id must be a non-empty string");
  }
  if (input.id.length > 200) {
    throw new BadRequestError(`id must be at most 200 characters, got ${input.id.length}`);
  }
  if (typeof input.title !== "string" || input.title.length > MAX_TITLE_CHARS) {
    throw new BadRequestError(`title must be a string of at most ${MAX_TITLE_CHARS} characters`);
  }
  if (typeof input.body !== "string" || input.body.trim() === "") {
    throw new BadRequestError("body must be a non-empty string");
  }
  if (input.body.length > MAX_BODY_CHARS) {
    throw new BadRequestError(`body must be at most ${MAX_BODY_CHARS} characters, got ${input.body.length}`);
  }
}

/** Writes documents and their chunks, and keeps the two in step. */
export class Store {
  readonly #sql: Sql;
  readonly #embedder: Embedder;
  readonly #chunkOptions: ChunkOptions;

  constructor(sql: Sql, embedder: Embedder, chunkOptions: ChunkOptions = {}) {
    this.#sql = sql;
    this.#embedder = embedder;
    this.#chunkOptions = chunkOptions;
  }

  /**
   * Stores a document and its chunks, replacing anything held under the same
   * id. The whole write is one transaction, so a failed embedding call leaves
   * the previous version in place rather than half of the new one.
   */
  async ingest(input: DocumentInput): Promise<IngestResult> {
    validate(input);
    const pieces = chunk(input.body, this.#chunkOptions);
    if (pieces.length === 0) throw new BadRequestError("body produced no chunks");
    const vectors = await this.#embedder.embed(pieces.map((piece) => piece.text));

    await this.#sql.query("BEGIN");
    try {
      const existing = await this.#sql.query<{ id: string }>(
        "SELECT id FROM documents WHERE external_id = $1",
        [input.id],
      );
      const replaced = existing.rows.length > 0;

      const { rows } = await this.#sql.query<{ id: string }>(
        `INSERT INTO documents (external_id, title, source, body, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (external_id) DO UPDATE
            SET title = EXCLUDED.title,
                source = EXCLUDED.source,
                body = EXCLUDED.body,
                metadata = EXCLUDED.metadata,
                updated_at = now()
         RETURNING id`,
        [input.id, input.title, input.source ?? null, input.body, JSON.stringify(input.metadata ?? {})],
      );
      const documentId = Number(rows[0]?.id);

      await this.#sql.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);

      const params: unknown[] = [];
      const tuples = pieces.map((piece, i) => {
        const base = params.length;
        params.push(
          documentId,
          piece.index,
          piece.text,
          piece.start,
          piece.end,
          this.#embedder.id,
          toVectorLiteral(vectors[i] as number[]),
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::vector)`;
      });
      await this.#sql.query(
        `INSERT INTO chunks (document_id, position, body, start_offset, end_offset, embedder, embedding)
         VALUES ${tuples.join(", ")}`,
        params,
      );

      await this.#sql.query("COMMIT");
      return { documentId, externalId: input.id, chunks: pieces.length, replaced };
    } catch (error) {
      await this.#sql.query("ROLLBACK");
      throw error;
    }
  }

  /** Deletes a document and its chunks. Returns false when there was nothing to delete. */
  async remove(externalId: string): Promise<boolean> {
    const { rows } = await this.#sql.query<{ id: string }>(
      "DELETE FROM documents WHERE external_id = $1 RETURNING id",
      [externalId],
    );
    return rows.length > 0;
  }

  async get(externalId: string): Promise<StoredDocument | null> {
    const { rows } = await this.#sql.query<{
      id: string;
      external_id: string;
      title: string;
      source: string | null;
      metadata: Record<string, unknown>;
      chunks: string;
    }>(
      `SELECT d.id, d.external_id, d.title, d.source, d.metadata,
              (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS chunks
         FROM documents d
        WHERE d.external_id = $1`,
      [externalId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      documentId: Number(row.id),
      externalId: row.external_id,
      title: row.title,
      source: row.source,
      metadata: row.metadata,
      chunks: Number(row.chunks),
    };
  }

  async stats(): Promise<{ documents: number; chunks: number; embedders: string[] }> {
    const { rows } = await this.#sql.query<{ documents: string; chunks: string; embedders: string[] | null }>(
      `SELECT (SELECT count(*) FROM documents) AS documents,
              (SELECT count(*) FROM chunks) AS chunks,
              (SELECT array_agg(DISTINCT embedder) FROM chunks) AS embedders`,
    );
    const row = rows[0];
    return {
      documents: Number(row?.documents ?? 0),
      chunks: Number(row?.chunks ?? 0),
      embedders: row?.embedders ?? [],
    };
  }
}
