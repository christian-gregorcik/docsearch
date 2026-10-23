#!/usr/bin/env node
import pg from "pg";
import { createApi } from "./api.ts";
import { readConfig } from "./config.ts";
import { DocsearchError } from "./errors.ts";
import { migrate } from "./migrate.ts";
import { Searcher } from "./search.ts";
import { Store } from "./store.ts";

const USAGE = `docsearch <command>

  migrate   create or update the schema, then exit
  serve     run the HTTP API

Settings come from the environment. DATABASE_URL is required; see the README.
`;

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "migrate" && command !== "serve") {
    process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return 2;
  }

  const config = readConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });

  if (command === "migrate") {
    const applied = await migrate(pool, {
      dimensions: config.embedder.dimensions,
      tsconfig: config.tsconfig,
    });
    process.stdout.write(applied.length === 0 ? "schema already current\n" : `applied ${applied.join(", ")}\n`);
    await pool.end();
    return 0;
  }

  if (config.token === undefined) {
    process.stderr.write("warning: DOCSEARCH_TOKEN is not set, every caller is allowed in\n");
  }
  const store = new Store(pool, config.embedder, config.chunk);
  const server = createApi({ store, searcher: new Searcher(pool, config.embedder, config.tsconfig), token: config.token });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  process.stderr.write(`listening on port ${config.port}, embedder ${config.embedder.id}\n`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => void pool.end().then(() => process.exit(0)));
    });
  }
  return 0;
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
} catch (error) {
  const message = error instanceof DocsearchError ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
