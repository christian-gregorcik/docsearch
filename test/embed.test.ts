import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HttpEmbedder, NgramEmbedder, toVectorLiteral } from "../src/embed.ts";
import { ConfigError, EmbeddingError } from "../src/errors.ts";

function cosine(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("NgramEmbedder", () => {
  const embedder = new NgramEmbedder(64);

  it("returns one vector per text, at the declared width", async () => {
    const vectors = await embedder.embed(["first", "second", "third"]);
    assert.equal(vectors.length, 3);
    for (const vector of vectors) assert.equal(vector.length, 64);
  });

  it("gives the same vector for the same text every time", async () => {
    const [a] = await embedder.embed(["repeatable input"]);
    const [b] = await new NgramEmbedder(64).embed(["repeatable input"]);
    assert.deepEqual(a, b);
  });

  it("returns unit vectors", async () => {
    const [vector] = await embedder.embed(["anything at all"]);
    assert.ok(Math.abs(cosine(vector as number[], vector as number[]) - 1) < 1e-9);
  });

  it("ignores case and surrounding whitespace", async () => {
    const [a, b] = await embedder.embed(["  Order Number  ", "order number"]);
    assert.deepEqual(a, b);
  });

  it("places a typo nearer the original than an unrelated phrase", async () => {
    const [original, typo, other] = await embedder.embed([
      "invoice payment terms",
      "invoce payment terms",
      "belts filters and blades",
    ]);
    const near = cosine(original as number[], typo as number[]);
    const far = cosine(original as number[], other as number[]);
    assert.ok(near > far, `typo ${near} should beat unrelated ${far}`);
  });

  it("handles an empty batch and empty text", async () => {
    assert.deepEqual(await embedder.embed([]), []);
    const [vector] = await embedder.embed([""]);
    assert.equal(vector?.length, 64);
  });

  it("refuses a width too small to be useful", () => {
    assert.throws(() => new NgramEmbedder(4), ConfigError);
    assert.throws(() => new NgramEmbedder(12.5), ConfigError);
  });

  it("names itself after its settings", () => {
    assert.equal(new NgramEmbedder(256).id, "ngram-3-256");
  });
});

describe("HttpEmbedder", () => {
  const base = { url: "https://example.test/v1/embeddings", model: "demo", dimensions: 3 };

  it("sends the batch and reads the vectors back", async () => {
    let seen: { url: string; body: unknown; auth: string | null } | undefined;
    const embedder = new HttpEmbedder({
      ...base,
      apiKey: "secret",
      fetch: async (input, init) => {
        seen = {
          url: String(input),
          body: JSON.parse(String(init?.body)) as unknown,
          auth: new Headers(init?.headers).get("authorization"),
        };
        return jsonResponse({ data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }] });
      },
    });
    const vectors = await embedder.embed(["a", "b"]);
    assert.deepEqual(vectors, [[1, 0, 0], [0, 1, 0]]);
    assert.equal(seen?.url, base.url);
    assert.equal(seen?.auth, "Bearer secret");
    assert.deepEqual(seen?.body, { model: "demo", input: ["a", "b"] });
  });

  it("skips the call entirely for an empty batch", async () => {
    let called = false;
    const embedder = new HttpEmbedder({
      ...base,
      fetch: async () => {
        called = true;
        return jsonResponse({ data: [] });
      },
    });
    assert.deepEqual(await embedder.embed([]), []);
    assert.equal(called, false);
  });

  it("reports the status when the endpoint refuses", async () => {
    const embedder = new HttpEmbedder({ ...base, fetch: async () => jsonResponse({ error: "nope" }, 429) });
    await assert.rejects(() => embedder.embed(["a"]), /answered 429/);
  });

  it("refuses a short batch", async () => {
    const embedder = new HttpEmbedder({ ...base, fetch: async () => jsonResponse({ data: [{ embedding: [1, 0, 0] }] }) });
    await assert.rejects(() => embedder.embed(["a", "b"]), EmbeddingError);
  });

  it("refuses a vector of the wrong width", async () => {
    const embedder = new HttpEmbedder({ ...base, fetch: async () => jsonResponse({ data: [{ embedding: [1, 0] }] }) });
    await assert.rejects(() => embedder.embed(["a"]), /has 2 dimensions/);
  });

  it("refuses values that are not finite numbers", async () => {
    const embedder = new HttpEmbedder({
      ...base,
      fetch: async () => jsonResponse({ data: [{ embedding: [1, null, "x"] }] }),
    });
    await assert.rejects(() => embedder.embed(["a"]), /finite numbers/);
  });

  it("refuses a url that is not http", () => {
    assert.throws(() => new HttpEmbedder({ ...base, url: "file:///etc/passwd" }), ConfigError);
  });

  it("leaves out the authorization header when no key is given", async () => {
    let auth: string | null = "unset";
    const embedder = new HttpEmbedder({
      ...base,
      fetch: async (_input, init) => {
        auth = new Headers(init?.headers).get("authorization");
        return jsonResponse({ data: [{ embedding: [0, 0, 1] }] });
      },
    });
    await embedder.embed(["a"]);
    assert.equal(auth, null);
  });
});

describe("toVectorLiteral", () => {
  it("writes the form pgvector parses", () => {
    assert.equal(toVectorLiteral([1, -0.5, 0]), "[1,-0.5,0]");
    assert.equal(toVectorLiteral([]), "[]");
  });
});
