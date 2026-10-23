import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Sql } from "./sql.ts";
import { assertDimensions, assertIdentifier, splitStatements } from "./sql.ts";

export interface MigrateOptions {
  /** Width of the vectors the chunks table will hold. */
  dimensions: number;
  /** Postgres text search configuration used for the lexical index. */
  tsconfig: string;
  /** Directory holding the numbered .sql files. Defaults to the one shipped here. */
  directory?: string | undefined;
}

const DEFAULT_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

/** Returns the migration file names in the order they must be applied. */
export async function listMigrations(directory = DEFAULT_DIRECTORY): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Applies every migration that has not run yet, one transaction each, and
 * records it. Running this twice in a row is a no-op the second time.
 */
export async function migrate(sql: Sql, options: MigrateOptions): Promise<string[]> {
  const dimensions = assertDimensions(options.dimensions);
  const tsconfig = assertIdentifier(options.tsconfig, "text search configuration");
  const directory = options.directory ?? DEFAULT_DIRECTORY;

  await sql.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await sql.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.name));
  const pending = (await listMigrations(directory)).filter((name) => !applied.has(name));

  for (const name of pending) {
    const template = await readFile(join(directory, name), "utf8");
    const statement = template
      .replaceAll(":dimensions", String(dimensions))
      .replaceAll(":tsconfig", tsconfig);
    await sql.query("BEGIN");
    try {
      for (const single of splitStatements(statement)) await sql.query(single);
      await sql.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK");
      throw error;
    }
  }
  return pending;
}
