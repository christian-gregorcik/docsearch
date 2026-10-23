import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApi } from "../src/api.ts";
import { DOCUMENTS, harness, type Harness } from "./helpers.ts";

const TOKEN = "test-token";

describe("HTTP API", () => {
  let h: Harness;
  let server: Server;
  let base: string;
  const logged: Record<string, unknown>[] = [];

  before(async () => {
    h = await harness();
    server = createApi({
      store: h.store,
      searcher: h.searcher,
      token: TOKEN,
      maxBodyBytes: 2048,
      log: (line) => logged.push(line),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  });

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init.headers },
    });

  it("answers the health check without a token", async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; documents: number };
    assert.equal(body.status, "ok");
    assert.equal(typeof body.documents, "number");
  });

  it("refuses a request with no token", async () => {
    const response = await fetch(`${base}/search`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
  });

  it("refuses a request with the wrong token", async () => {
    for (const bad of ["wrong", "", "test-token-longer", "test-toke"]) {
      const response = await fetch(`${base}/search`, {
        method: "POST",
        headers: { authorization: `Bearer ${bad}` },
        body: "{}",
      });
      assert.equal(response.status, 401, bad);
    }
  });

  it("ingests a document and answers 201", async () => {
    const response = await call("/documents", { method: "POST", body: JSON.stringify(DOCUMENTS[0]) });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { chunks: number; replaced: boolean };
    assert.ok(body.chunks >= 1);
    assert.equal(body.replaced, false);
  });

  it("answers 200 when the same id is ingested again", async () => {
    const response = await call("/documents", { method: "POST", body: JSON.stringify(DOCUMENTS[0]) });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { replaced: boolean }).replaced, true);
  });

  it("reads a document back", async () => {
    const response = await call("/documents/refunds");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { title: string }).title, "Refund policy");
  });

  it("searches and returns hits", async () => {
    const response = await call("/search", { method: "POST", body: JSON.stringify({ query: "order number", limit: 3 }) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { hits: { externalId: string }[]; mode: string };
    assert.equal(body.mode, "hybrid");
    assert.equal(body.hits[0]?.externalId, "refunds");
  });

  it("passes the filter through", async () => {
    const response = await call("/search", {
      method: "POST",
      body: JSON.stringify({ query: "refund", filter: { team: "finance" } }),
    });
    assert.equal(((await response.json()) as { hits: unknown[] }).hits.length, 0);
  });

  it("turns a validation problem into 400 with the reason", async () => {
    const response = await call("/search", { method: "POST", body: JSON.stringify({ query: "" }) });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /query must be/);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await call("/search", { method: "POST", body: "{nope" });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /valid JSON/);
  });

  it("rejects a body that is not an object", async () => {
    const response = await call("/search", { method: "POST", body: "[1,2,3]" });
    assert.equal(response.status, 400);
  });

  it("rejects a body over the limit", async () => {
    const response = await call("/documents", {
      method: "POST",
      body: JSON.stringify({ id: "big", title: "Big", body: "x".repeat(4000) }),
    });
    assert.equal(response.status, 413);
  });

  it("deletes a document and then reports it gone", async () => {
    assert.equal((await call("/documents/refunds", { method: "DELETE" })).status, 204);
    assert.equal((await call("/documents/refunds", { method: "DELETE" })).status, 404);
    assert.equal((await call("/documents/refunds")).status, 404);
  });

  it("handles an id that needed escaping in the path", async () => {
    await call("/documents", { method: "POST", body: JSON.stringify({ id: "a/b c", title: "Odd id", body: "Body text." }) });
    const response = await call(`/documents/${encodeURIComponent("a/b c")}`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { externalId: string }).externalId, "a/b c");
  });

  it("answers 404 for a route it does not have", async () => {
    assert.equal((await call("/nope")).status, 404);
    assert.equal((await call("/documents", { method: "PUT" })).status, 404);
  });

  it("puts a request id on every answer and logs one line per request", async () => {
    const before = logged.length;
    const response = await call("/healthz");
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
    assert.ok(logged.length > before);
    assert.equal(logged[logged.length - 1]?.path, "/healthz");
  });

  it("lets a caller through when no token is configured", async () => {
    const open = createApi({ store: h.store, searcher: h.searcher, log: () => {} });
    await new Promise<void>((resolve) => open.listen(0, "127.0.0.1", resolve));
    try {
      const port = (open.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        body: JSON.stringify({ query: "warranty" }),
      });
      assert.equal(response.status, 200);
    } finally {
      await new Promise<void>((resolve) => open.close(() => resolve()));
    }
  });
});
