/**
 * Measures the three retrieval modes against a labelled set of queries.
 *
 * Runs against an in-memory Postgres, so it needs nothing installed and gives
 * the same numbers on every machine. Point EMBEDDER at a real endpoint to see
 * what a semantic model does to the vector arm.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { NgramEmbedder, type Embedder } from "../src/embed.ts";
import { migrate } from "../src/migrate.ts";
import { Searcher, type SearchMode } from "../src/search.ts";
import type { Sql } from "../src/sql.ts";
import { Store } from "../src/store.ts";

interface Dataset {
  name: string;
  documents: { id: string; title: string; body: string }[];
  queries: { query: string; relevant: string[] }[];
}

interface Score {
  mode: SearchMode;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  misses: string[];
}

const CUTOFFS = [1, 3, 5] as const;

/** Document ids in the order they first appear among the hits. */
function documentsRanked(hits: readonly { externalId: string }[]): string[] {
  const seen: string[] = [];
  for (const hit of hits) if (!seen.includes(hit.externalId)) seen.push(hit.externalId);
  return seen;
}

async function score(searcher: Searcher, dataset: Dataset, mode: SearchMode): Promise<Score> {
  const found: Record<number, number> = { 1: 0, 3: 0, 5: 0 };
  const misses: string[] = [];
  let reciprocal = 0;

  for (const task of dataset.queries) {
    const result = await searcher.search(task.query, { mode, limit: 10, candidates: 50 });
    const ranked = documentsRanked(result.hits);
    const position = ranked.findIndex((id) => task.relevant.includes(id));
    if (position === -1) {
      misses.push(task.query);
      continue;
    }
    reciprocal += 1 / (position + 1);
    for (const cutoff of CUTOFFS) if (position < cutoff) found[cutoff] = (found[cutoff] ?? 0) + 1;
  }

  const total = dataset.queries.length;
  return {
    mode,
    recallAt1: (found[1] ?? 0) / total,
    recallAt3: (found[3] ?? 0) / total,
    recallAt5: (found[5] ?? 0) / total,
    mrr: reciprocal / total,
    misses,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`.padStart(6);
}

async function main(): Promise<void> {
  const path = fileURLToPath(new URL("./dataset.json", import.meta.url));
  const dataset = JSON.parse(await readFile(path, "utf8")) as Dataset;

  const embedder: Embedder = new NgramEmbedder(256);
  const db = await new PGlite({ extensions: { vector } });
  const sql = db as unknown as Sql;
  await migrate(sql, { dimensions: embedder.dimensions, tsconfig: "english" });

  const store = new Store(sql, embedder, { maxChars: 400, overlapChars: 80 });
  for (const document of dataset.documents) await store.ingest(document);
  const stats = await store.stats();

  const searcher = new Searcher(sql, embedder, "english");
  const scores: Score[] = [];
  for (const mode of ["lexical", "vector", "hybrid"] as const) {
    scores.push(await score(searcher, dataset, mode));
  }

  const lines = [
    `${dataset.name}: ${stats.documents} documents, ${stats.chunks} chunks, ${dataset.queries.length} queries, embedder ${embedder.id}`,
    "",
    "mode      recall@1  recall@3  recall@5     mrr   missed",
    "--------  --------  --------  --------  ------  -------",
  ];
  for (const s of scores) {
    lines.push(
      `${s.mode.padEnd(8)}  ${percent(s.recallAt1)}    ${percent(s.recallAt3)}    ${percent(s.recallAt5)}  ` +
        `${s.mrr.toFixed(3).padStart(6)}  ${String(s.misses.length).padStart(7)}`,
    );
  }

  const hybrid = scores.find((s) => s.mode === "hybrid");
  if (hybrid !== undefined && hybrid.misses.length > 0) {
    lines.push("", "queries hybrid search still misses:");
    for (const query of hybrid.misses) lines.push(`  ${query}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  await db.close();
}

await main();
