/**
 * Starts the API against an in-memory Postgres, loads the eval corpus and
 * makes three real requests. The output in the README is this script's output.
 *
 *   node --experimental-strip-types examples/demo.ts
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { createApi } from "../src/api.ts";
import { NgramEmbedder } from "../src/embed.ts";
import { migrate } from "../src/migrate.ts";
import { Searcher } from "../src/search.ts";
import type { Sql } from "../src/sql.ts";
import { Store } from "../src/store.ts";

const TOKEN = "demo-token";

const embedder = new NgramEmbedder(256);
const db = await new PGlite({ extensions: { vector } });
const sql = db as unknown as Sql;
await migrate(sql, { dimensions: embedder.dimensions, tsconfig: "english" });

const store = new Store(sql, embedder, { maxChars: 400, overlapChars: 80 });
const searcher = new Searcher(sql, embedder, "english");
const server = createApi({ store, searcher, token: TOKEN, log: () => {} });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const corpus = JSON.parse(
  await readFile(fileURLToPath(new URL("../eval/dataset.json", import.meta.url)), "utf8"),
) as { documents: { id: string; title: string; body: string }[] };

async function show(method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  process.stdout.write(`$ ${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}\n`);
  process.stdout.write(`${response.status}\n${text === "" ? "" : `${JSON.stringify(JSON.parse(text), null, 2)}\n`}\n`);
}

for (const document of corpus.documents) {
  await fetch(`${base}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ ...document, metadata: { team: "support" } }),
  });
}

await show("GET", "/healthz");
await show("POST", "/search", { query: "warrenty on belts", limit: 2 });
await show("POST", "/search", { query: "how do I pack the box for a return", limit: 2, mode: "lexical" });

await new Promise<void>((resolve) => server.close(() => resolve()));
await db.close();
