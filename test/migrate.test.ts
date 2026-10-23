import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { listMigrations, migrate } from "../src/migrate.ts";
import type { Sql } from "../src/sql.ts";

async function blank(): Promise<{ sql: Sql; close: () => Promise<void> }> {
  const db = await new PGlite({ extensions: { vector } });
  return { sql: db as unknown as Sql, close: () => db.close() };
}

describe("migrate", () => {
  it("lists the files in the order they apply", async () => {
    const names = await listMigrations();
    assert.ok(names.length > 0);
    assert.deepEqual(names, [...names].sort());
    for (const name of names) assert.match(name, /^\d{3}_[a-z_]+\.sql$/);
  });

  it("creates the schema and records what it applied", async () => {
    const db = await blank();
    try {
      const applied = await migrate(db.sql, { dimensions: 16, tsconfig: "english" });
      assert.deepEqual(applied, await listMigrations());
      const { rows } = await db.sql.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      assert.deepEqual(rows.map((row) => row.name), applied);
    } finally {
      await db.close();
    }
  });

  it("does nothing the second time", async () => {
    const db = await blank();
    try {
      await migrate(db.sql, { dimensions: 16, tsconfig: "english" });
      assert.deepEqual(await migrate(db.sql, { dimensions: 16, tsconfig: "english" }), []);
    } finally {
      await db.close();
    }
  });

  it("builds the vector column at the width it was given", async () => {
    const db = await blank();
    try {
      await migrate(db.sql, { dimensions: 24, tsconfig: "english" });
      const { rows } = await db.sql.query<{ type: string }>(
        "SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'",
      );
      assert.equal(rows[0]?.type, "vector(24)");
    } finally {
      await db.close();
    }
  });

  it("uses the text search configuration it was given", async () => {
    const db = await blank();
    try {
      await migrate(db.sql, { dimensions: 16, tsconfig: "swedish" });
      const { rows } = await db.sql.query<{ definition: string }>(
        "SELECT pg_get_expr(adbin, adrelid) AS definition FROM pg_attrdef WHERE adrelid = 'chunks'::regclass",
      );
      assert.ok(rows.some((row) => row.definition.includes("swedish")), JSON.stringify(rows));
    } finally {
      await db.close();
    }
  });

  it("refuses a configuration name that is not a plain identifier", async () => {
    const db = await blank();
    try {
      await assert.rejects(
        () => migrate(db.sql, { dimensions: 16, tsconfig: "english'); DROP TABLE chunks; --" }),
        /text search configuration/,
      );
    } finally {
      await db.close();
    }
  });

  it("refuses a vector width Postgres would not accept", async () => {
    const db = await blank();
    try {
      await assert.rejects(() => migrate(db.sql, { dimensions: 0, tsconfig: "english" }), /dimensions/);
    } finally {
      await db.close();
    }
  });
});
