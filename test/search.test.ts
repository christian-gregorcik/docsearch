import { strict as assert } from "node:assert";
import { before, after, describe, it } from "node:test";
import { BadRequestError } from "../src/errors.ts";
import { DOCUMENTS, harness, type Harness } from "./helpers.ts";

describe("Searcher", () => {
  let h: Harness;

  before(async () => {
    h = await harness();
    for (const document of DOCUMENTS) await h.store.ingest(document);
  });

  after(async () => {
    await h.close();
  });

  it("finds the document that uses the words in the query", async () => {
    const result = await h.searcher.search("warranty wear parts belts");
    assert.equal(result.hits[0]?.externalId, "warranty");
    assert.ok(result.hits[0]!.score > 0);
  });

  it("explains which arm found a hit and where it placed it", async () => {
    const result = await h.searcher.search("interest on late payment");
    const first = result.hits[0];
    assert.equal(first?.externalId, "invoicing");
    assert.ok(Object.keys(first!.ranks).length >= 1);
    for (const rank of Object.values(first!.ranks)) assert.ok(rank >= 1);
  });

  it("still finds the right document when the query is misspelled", async () => {
    const lexical = await h.searcher.search("warrenty wearr partss", { mode: "lexical" });
    const hybrid = await h.searcher.search("warrenty wearr partss", { mode: "hybrid" });
    assert.equal(lexical.hits.length, 0, "exact matching should miss this one");
    assert.equal(hybrid.hits[0]?.externalId, "warranty");
  });

  it("returns a hit with the text and the offsets to show it in context", async () => {
    const result = await h.searcher.search("photograph of the packaging");
    const hit = result.hits[0];
    assert.ok(hit !== undefined);
    assert.equal(DOCUMENTS.find((d) => d.id === hit.externalId)!.body.slice(hit.start, hit.end), hit.text);
    assert.equal(hit.title, "Refund policy");
  });

  it("honours the limit", async () => {
    const result = await h.searcher.search("the", { limit: 2, candidates: 20 });
    assert.ok(result.hits.length <= 2);
  });

  it("reports how many candidates each arm returned", async () => {
    const result = await h.searcher.search("warranty", { limit: 3, candidates: 5 });
    assert.deepEqual(Object.keys(result.considered).sort(), ["lexical", "vector"]);
    for (const count of Object.values(result.considered)) assert.ok(count <= 5);
  });

  it("runs a single arm when asked to", async () => {
    const lexical = await h.searcher.search("warranty", { mode: "lexical" });
    assert.deepEqual(Object.keys(lexical.considered), ["lexical"]);
    const vector = await h.searcher.search("warranty", { mode: "vector" });
    assert.deepEqual(Object.keys(vector.considered), ["vector"]);
    assert.equal(vector.mode, "vector");
  });

  it("narrows the search to documents whose metadata matches the filter", async () => {
    const finance = await h.searcher.search("terms", { filter: { team: "finance" } });
    assert.ok(finance.hits.length > 0);
    for (const hit of finance.hits) assert.equal(hit.externalId, "invoicing");

    const none = await h.searcher.search("terms", { filter: { team: "nobody" } });
    assert.equal(none.hits.length, 0);
  });

  it("still matches when the query carries a word the document does not use", async () => {
    const result = await h.searcher.search("warranty covers belts and unicorns", { mode: "lexical" });
    assert.equal(result.hits[0]?.externalId, "warranty");
  });

  it("ranks the document that carries more of the query first", async () => {
    const result = await h.searcher.search("warranty belts filters blades", { mode: "lexical" });
    assert.equal(result.hits[0]?.externalId, "warranty");
  });

  it("returns nothing rather than failing when nothing matches", async () => {
    const result = await h.searcher.search("zzzzqqq nonexistent gibberish", { mode: "lexical" });
    assert.deepEqual(result.hits, []);
  });

  it("times itself", async () => {
    const result = await h.searcher.search("warranty");
    assert.ok(result.tookMs >= 0 && Number.isFinite(result.tookMs));
  });

  it("refuses a query or settings it cannot run", async () => {
    await assert.rejects(() => h.searcher.search("   "), BadRequestError);
    await assert.rejects(() => h.searcher.search("x".repeat(1001)), BadRequestError);
    await assert.rejects(() => h.searcher.search("a", { limit: 0 }), BadRequestError);
    await assert.rejects(() => h.searcher.search("a", { limit: 101 }), BadRequestError);
    await assert.rejects(() => h.searcher.search("a", { limit: 10, candidates: 5 }), BadRequestError);
    await assert.rejects(() => h.searcher.search("a", { mode: "magic" as never }), BadRequestError);
  });

  it("treats a query full of punctuation as no match rather than an error", async () => {
    const result = await h.searcher.search("??? !!! ,,,", { mode: "lexical" });
    assert.deepEqual(result.hits, []);
  });

  it("does not let a quote in the query break the query", async () => {
    const result = await h.searcher.search("o'brien'); drop table chunks; --");
    assert.ok(Array.isArray(result.hits));
    assert.equal((await h.store.stats()).documents, DOCUMENTS.length);
  });

  it("ignores chunks written by a different embedder", async () => {
    const { Searcher } = await import("../src/search.ts");
    const { NgramEmbedder } = await import("../src/embed.ts");
    const other = new NgramEmbedder(128);
    Object.defineProperty(other, "id", { value: "someone-else" });
    const searcher = new Searcher(h.sql, other, "english");
    const result = await searcher.search("warranty", { mode: "vector" });
    assert.deepEqual(result.hits, []);
  });
});
