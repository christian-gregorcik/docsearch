import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertDimensions, assertIdentifier, splitStatements } from "../src/sql.ts";

describe("splitStatements", () => {
  it("splits on semicolons and trims", () => {
    assert.deepEqual(splitStatements("SELECT 1;\n SELECT 2; "), ["SELECT 1", "SELECT 2"]);
  });

  it("accepts a final statement without a semicolon", () => {
    assert.deepEqual(splitStatements("SELECT 1"), ["SELECT 1"]);
  });

  it("drops empty statements", () => {
    assert.deepEqual(splitStatements(";;\nSELECT 1;;"), ["SELECT 1"]);
  });

  it("keeps a semicolon inside a string literal", () => {
    assert.deepEqual(splitStatements("SELECT 'a;b'; SELECT 2"), ["SELECT 'a;b'", "SELECT 2"]);
  });

  it("handles a doubled quote inside a string literal", () => {
    assert.deepEqual(splitStatements("SELECT 'it''s; fine'; SELECT 2"), ["SELECT 'it''s; fine'", "SELECT 2"]);
  });

  it("keeps a semicolon inside a quoted identifier", () => {
    assert.deepEqual(splitStatements('SELECT "od;d"; SELECT 2'), ['SELECT "od;d"', "SELECT 2"]);
  });

  it("keeps a semicolon inside a dollar quoted block", () => {
    const script = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END $body$ LANGUAGE plpgsql; SELECT 1";
    assert.equal(splitStatements(script).length, 2);
  });

  it("ignores a semicolon in a line comment", () => {
    assert.deepEqual(splitStatements("SELECT 1 -- and; more\n; SELECT 2"), ["SELECT 1 -- and; more", "SELECT 2"]);
  });

  it("ignores a semicolon in a block comment", () => {
    assert.deepEqual(splitStatements("SELECT 1 /* ; */; SELECT 2"), ["SELECT 1 /* ; */", "SELECT 2"]);
  });

  it("survives an unterminated literal without looping", () => {
    assert.deepEqual(splitStatements("SELECT 'open"), ["SELECT 'open"]);
  });
});

describe("assertIdentifier", () => {
  it("passes plain lower case names", () => {
    assert.equal(assertIdentifier("swedish", "config"), "swedish");
    assert.equal(assertIdentifier("my_config2", "config"), "my_config2");
  });

  it("refuses anything that could end a quoted context", () => {
    for (const bad of ["english; DROP TABLE chunks", "English", "2fast", "", "a-b", "a b"]) {
      assert.throws(() => assertIdentifier(bad, "config"), /config must match/);
    }
  });
});

describe("assertDimensions", () => {
  it("accepts a sensible width", () => {
    assert.equal(assertDimensions(256), 256);
  });

  it("refuses anything Postgres would not take", () => {
    for (const bad of [0, -1, 1.5, 20_000, Number.NaN]) {
      assert.throws(() => assertDimensions(bad), /embedding dimensions/);
    }
  });
});
