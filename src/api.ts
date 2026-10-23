import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { BadRequestError } from "./errors.ts";
import type { SearchOptions, Searcher } from "./search.ts";
import type { Store } from "./store.ts";

export interface ApiOptions {
  store: Store;
  searcher: Searcher;
  /** Required on every route but /healthz. Omit only behind your own gateway. */
  token?: string | undefined;
  maxBodyBytes?: number | undefined;
  /** Where request lines go. Defaults to stderr, so stdout stays clean. */
  log?: ((line: Record<string, unknown>) => void) | undefined;
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Constant-time compare that does not leak the expected length. */
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  const padded = Buffer.alloc(a.length);
  b.copy(padded, 0, 0, Math.min(a.length, b.length));
  return timingSafeEqual(a, padded) && a.length === b.length;
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `body must be at most ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const piece of request) {
    const buffer = piece as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, `body must be at most ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${what} must be a string`);
  return value;
}

function searchOptions(body: Record<string, unknown>): SearchOptions {
  const options: SearchOptions = {};
  if (body.limit !== undefined) options.limit = Number(body.limit);
  if (body.candidates !== undefined) options.candidates = Number(body.candidates);
  if (body.rrfK !== undefined) options.rrfK = Number(body.rrfK);
  if (body.mode !== undefined) options.mode = body.mode as SearchOptions["mode"];
  if (body.filter !== undefined) options.filter = asObject(body.filter, "filter");
  return options;
}

/**
 * The HTTP surface: ingest, delete, look up and search.
 *
 * Everything but /healthz needs the bearer token. Validation errors come back
 * as 400 with the reason; anything unexpected is logged with a request id and
 * answered with a bare 500, so an internal message never reaches the caller.
 */
export function createApi(options: ApiOptions): Server {
  const { store, searcher } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = options.log ?? ((line) => process.stderr.write(`${JSON.stringify(line)}\n`));

  return createServer((request, response) => {
    const requestId = randomUUID();
    const started = performance.now();
    void handle(request, response, requestId)
      .catch((error: unknown) => fail(response, error, requestId, log))
      .finally(() => {
        log({
          at: new Date().toISOString(),
          requestId,
          method: request.method,
          path: (request.url ?? "").split("?")[0],
          status: response.statusCode,
          ms: Math.round((performance.now() - started) * 10) / 10,
        });
      });
  });

  async function handle(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (method === "GET" && path === "/healthz") {
      send(response, 200, { status: "ok", ...(await store.stats()) }, requestId);
      return;
    }

    authorize(request);

    if (method === "POST" && path === "/documents") {
      const body = asObject(await readJson(request, maxBodyBytes), "body");
      const result = await store.ingest({
        id: String(body.id ?? ""),
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        source: optionalString(body.source, "source"),
        metadata: body.metadata === undefined ? undefined : asObject(body.metadata, "metadata"),
      });
      send(response, result.replaced ? 200 : 201, result, requestId);
      return;
    }

    if (method === "POST" && path === "/search") {
      const body = asObject(await readJson(request, maxBodyBytes), "body");
      const query = optionalString(body.query, "query") ?? "";
      send(response, 200, await searcher.search(query, searchOptions(body)), requestId);
      return;
    }

    const document = /^\/documents\/(.+)$/.exec(path);
    if (document !== null) {
      const id = decodeURIComponent(document[1] as string);
      if (method === "GET") {
        const found = await store.get(id);
        if (found === null) throw new HttpError(404, `no document with id ${JSON.stringify(id)}`);
        send(response, 200, found, requestId);
        return;
      }
      if (method === "DELETE") {
        const removed = await store.remove(id);
        if (!removed) throw new HttpError(404, `no document with id ${JSON.stringify(id)}`);
        send(response, 204, null, requestId);
        return;
      }
    }

    throw new HttpError(404, `no route for ${method} ${path}`);
  }

  function authorize(request: IncomingMessage): void {
    if (options.token === undefined) return;
    const header = request.headers.authorization ?? "";
    const given = /^Bearer (.+)$/.exec(header)?.[1];
    if (given === undefined || !tokenMatches(options.token, given)) {
      throw new HttpError(401, "missing or wrong bearer token");
    }
  }
}

function send(response: ServerResponse, status: number, body: unknown, requestId: string): void {
  response.setHeader("x-request-id", requestId);
  if (body === null) {
    response.writeHead(status).end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function fail(
  response: ServerResponse,
  error: unknown,
  requestId: string,
  log: (line: Record<string, unknown>) => void,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof HttpError) {
    send(response, error.status, { error: error.message }, requestId);
    return;
  }
  if (error instanceof BadRequestError) {
    send(response, 400, { error: error.message }, requestId);
    return;
  }
  log({
    at: new Date().toISOString(),
    requestId,
    level: "error",
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  send(response, 500, { error: "internal error", requestId }, requestId);
}
