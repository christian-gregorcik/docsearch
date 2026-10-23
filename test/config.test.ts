import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

const MINIMUM = { DATABASE_URL: "postgres://localhost/docsearch" };

describe("readConfig", () => {
  it("fills in defaults around the one required setting", () => {
    const config = readConfig(MINIMUM);
    assert.equal(config.port, 8080);
    assert.equal(config.tsconfig, "english");
    assert.equal(config.token, undefined);
    assert.equal(config.embedder.id, "ngram-3-256");
    assert.deepEqual(config.chunk, { maxChars: 900, overlapChars: 150 });
  });

  it("insists on a database url", () => {
    assert.throws(() => readConfig({}), ConfigError);
    assert.throws(() => readConfig({ DATABASE_URL: "  " }), /DATABASE_URL is not set/);
  });

  it("reads the overrides it is given", () => {
    const config = readConfig({
      ...MINIMUM,
      PORT: "9000",
      DOCSEARCH_TOKEN: "s3cret",
      TEXT_SEARCH_CONFIG: "swedish",
      EMBED_DIMENSIONS: "64",
      CHUNK_MAX_CHARS: "400",
      CHUNK_OVERLAP_CHARS: "50",
    });
    assert.equal(config.port, 9000);
    assert.equal(config.token, "s3cret");
    assert.equal(config.tsconfig, "swedish");
    assert.equal(config.embedder.dimensions, 64);
    assert.deepEqual(config.chunk, { maxChars: 400, overlapChars: 50 });
  });

  it("builds an http embedder when asked", () => {
    const config = readConfig({
      ...MINIMUM,
      EMBEDDER: "http",
      EMBED_URL: "https://api.example.test/v1/embeddings",
      EMBED_MODEL: "embed-small",
      EMBED_DIMENSIONS: "1024",
    });
    assert.equal(config.embedder.id, "embed-small");
    assert.equal(config.embedder.dimensions, 1024);
  });

  it("says what is missing for an http embedder", () => {
    assert.throws(() => readConfig({ ...MINIMUM, EMBEDDER: "http" }), /EMBED_URL is not set/);
    assert.throws(
      () => readConfig({ ...MINIMUM, EMBEDDER: "http", EMBED_URL: "https://x.test/e" }),
      /EMBED_MODEL is not set/,
    );
  });

  it("refuses an embedder it does not know", () => {
    assert.throws(() => readConfig({ ...MINIMUM, EMBEDDER: "magic" }), /EMBEDDER must be/);
  });

  it("refuses a number that is not one", () => {
    assert.throws(() => readConfig({ ...MINIMUM, PORT: "eight" }), /PORT must be an integer/);
  });
});
