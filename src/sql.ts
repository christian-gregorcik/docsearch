/**
 * The slice of a Postgres client this package uses.
 *
 * Both `pg.Pool` and an embedded PGlite instance satisfy it, which is how the
 * test suite runs the real SQL without a server.
 */
export interface Sql {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

/** Postgres identifiers this package is willing to interpolate into DDL. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export function assertIdentifier(value: string, what: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${what} must match ${String(SAFE_IDENTIFIER)}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertDimensions(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 16_000) {
    throw new Error(`embedding dimensions must be an integer between 1 and 16000, got ${String(value)}`);
  }
  return value;
}

/**
 * Splits a SQL script into single statements.
 *
 * Needed because a parameterised protocol connection refuses more than one
 * command per message, so a migration file has to be fed in one statement at a
 * time. Quoted strings, quoted identifiers, dollar-quoted blocks and both
 * comment styles are skipped over, so a semicolon inside any of them does not
 * cut the statement in half.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;

  while (i < script.length) {
    const rest = script.slice(i);
    if (rest.startsWith("--")) {
      const end = script.indexOf("\n", i);
      i = end === -1 ? script.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = script.indexOf("*/", i + 2);
      i = end === -1 ? script.length : end + 2;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar !== null) {
      const tag = dollar[0];
      const end = script.indexOf(tag, i + tag.length);
      i = end === -1 ? script.length : end + tag.length;
      continue;
    }
    const char = script[i] as string;
    if (char === "'" || char === '"') {
      i += 1;
      while (i < script.length) {
        if (script[i] === char) {
          if (script[i + 1] === char) i += 2;
          else break;
        } else {
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    if (char === ";") {
      push(script.slice(start, i));
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  push(script.slice(start));
  return out;

  function push(statement: string): void {
    if (statement.trim() !== "") out.push(statement.trim());
  }
}
