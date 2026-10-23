import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { NgramEmbedder, type Embedder } from "../src/embed.ts";
import { migrate } from "../src/migrate.ts";
import { Searcher } from "../src/search.ts";
import type { Sql } from "../src/sql.ts";
import { Store } from "../src/store.ts";
import type { ChunkOptions } from "../src/chunk.ts";

export interface Harness {
  sql: Sql;
  store: Store;
  searcher: Searcher;
  embedder: Embedder;
  close(): Promise<void>;
}

/** An empty, migrated database held in memory. Every test gets its own. */
export async function harness(chunkOptions: ChunkOptions = { maxChars: 240, overlapChars: 40 }): Promise<Harness> {
  const db = await new PGlite({ extensions: { vector } });
  const embedder = new NgramEmbedder(128);
  const sql = db as unknown as Sql;
  await migrate(sql, { dimensions: embedder.dimensions, tsconfig: "english" });
  return {
    sql,
    embedder,
    store: new Store(sql, embedder, chunkOptions),
    searcher: new Searcher(sql, embedder, "english"),
    close: () => db.close(),
  };
}

export const DOCUMENTS = [
  {
    id: "refunds",
    title: "Refund policy",
    body:
      "We refund unopened goods within 30 days of delivery.\n\n" +
      "Shipping costs are not refunded unless the item arrived damaged or the wrong item was sent.\n\n" +
      "To start a return, email support with your order number and a photograph of the packaging.",
    metadata: { team: "support", language: "en" },
  },
  {
    id: "warranty",
    title: "Warranty terms",
    body:
      "Every machine carries a two year warranty against manufacturing defects.\n\n" +
      "The warranty does not cover wear parts such as belts, filters and blades.\n\n" +
      "Repairs under warranty are carried out at our workshop; transport is arranged by us.",
    metadata: { team: "support", language: "en" },
  },
  {
    id: "invoicing",
    title: "Invoicing and payment terms",
    body:
      "Invoices are sent by email on the day the order ships, with thirty days to pay.\n\n" +
      "Late payment carries interest at the reference rate plus eight percentage points.\n\n" +
      "Ask the finance team for a different arrangement before the order is placed, not after.",
    metadata: { team: "finance", language: "en" },
  },
];
