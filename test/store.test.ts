import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BadRequestError } from "../src/errors.ts";
import { DOCUMENTS, harness } from "./helpers.ts";

describe("Store", () => {
  it("stores a document and its chunks", async () => {
    const h = await harness();
    try {
      const result = await h.store.ingest(DOCUMENTS[0]!);
      assert.equal(result.externalId, "refunds");
      assert.equal(result.replaced, false);
      assert.ok(result.chunks >= 1);
      assert.deepEqual(await h.store.stats(), {
        documents: 1,
        chunks: result.chunks,
        embedders: [h.embedder.id],
      });
    } finally {
      await h.close();
    }
  });

  it("replaces a document ingested under the same id", async () => {
    const h = await harness();
    try {
      await h.store.ingest(DOCUMENTS[0]!);
      const again = await h.store.ingest({ ...DOCUMENTS[0]!, title: "Refunds, revised", body: "Shorter now." });
      assert.equal(again.replaced, true);
      const stored = await h.store.get("refunds");
      assert.equal(stored?.title, "Refunds, revised");
      const stats = await h.store.stats();
      assert.equal(stats.documents, 1);
      assert.equal(stats.chunks, again.chunks);
    } finally {
      await h.close();
    }
  });

  it("keeps chunk positions and offsets that point into the body", async () => {
    const h = await harness();
    try {
      await h.store.ingest(DOCUMENTS[1]!);
      const { rows } = await h.sql.query<{ position: number; body: string; start_offset: number; end_offset: number }>(
        "SELECT position, body, start_offset, end_offset FROM chunks ORDER BY position",
      );
      rows.forEach((row, i) => {
        assert.equal(Number(row.position), i);
        assert.equal(DOCUMENTS[1]!.body.slice(Number(row.start_offset), Number(row.end_offset)), row.body);
      });
    } finally {
      await h.close();
    }
  });

  it("reads a document back with its metadata and chunk count", async () => {
    const h = await harness();
    try {
      const result = await h.store.ingest(DOCUMENTS[2]!);
      const stored = await h.store.get("invoicing");
      assert.equal(stored?.chunks, result.chunks);
      assert.deepEqual(stored?.metadata, { team: "finance", language: "en" });
      assert.equal(stored?.source, null);
    } finally {
      await h.close();
    }
  });

  it("answers null for a document that was never stored", async () => {
    const h = await harness();
    try {
      assert.equal(await h.store.get("missing"), null);
    } finally {
      await h.close();
    }
  });

  it("deletes a document and its chunks together", async () => {
    const h = await harness();
    try {
      await h.store.ingest(DOCUMENTS[0]!);
      assert.equal(await h.store.remove("refunds"), true);
      assert.equal(await h.store.remove("refunds"), false);
      assert.deepEqual(await h.store.stats(), { documents: 0, chunks: 0, embedders: [] });
    } finally {
      await h.close();
    }
  });

  it("leaves the previous version in place when embedding fails", async () => {
    const h = await harness();
    try {
      await h.store.ingest(DOCUMENTS[0]!);
      const broken = new (class {
        readonly dimensions = h.embedder.dimensions;
        readonly id = h.embedder.id;
        embed(): Promise<number[][]> {
          return Promise.reject(new Error("embedding backend is down"));
        }
      })();
      const { Store } = await import("../src/store.ts");
      const store = new Store(h.sql, broken);
      await assert.rejects(() => store.ingest({ ...DOCUMENTS[0]!, body: "Replacement text." }), /backend is down/);
      assert.equal((await h.store.get("refunds"))?.title, "Refund policy");
    } finally {
      await h.close();
    }
  });

  it("refuses input it cannot store", async () => {
    const h = await harness();
    try {
      const good = DOCUMENTS[0]!;
      await assert.rejects(() => h.store.ingest({ ...good, id: "" }), BadRequestError);
      await assert.rejects(() => h.store.ingest({ ...good, id: "x".repeat(201) }), BadRequestError);
      await assert.rejects(() => h.store.ingest({ ...good, body: "   " }), BadRequestError);
      await assert.rejects(() => h.store.ingest({ ...good, title: "t".repeat(501) }), BadRequestError);
    } finally {
      await h.close();
    }
  });

  it("stores a body with a quote and a backslash unharmed", async () => {
    const h = await harness();
    try {
      const body = "O'Brien said \\n is not a newline; the path was C:\\temp.";
      await h.store.ingest({ id: "odd", title: "Odd characters", body });
      const { rows } = await h.sql.query<{ body: string }>("SELECT body FROM documents WHERE external_id = 'odd'");
      assert.equal(rows[0]?.body, body);
    } finally {
      await h.close();
    }
  });
});
