# docsearch

Search over your own documents, in one Postgres database. Full-text search and
vector search run side by side and their results are merged with reciprocal
rank fusion, behind a small HTTP API.

There is no separate vector store, no queue and no background worker. A
document goes in, it is split into chunks, every chunk gets a `tsvector` and an
embedding in the same row, and a query reads both indexes and fuses the two
lists.

## Why two kinds of search

They fail differently, and the failures do not overlap.

Full-text search is exact. Ask it for `warranty belts` and it finds the
paragraph that uses those words. Ask it for `warrenty` and it finds nothing at
all, because a stem that does not exist matches nothing.

Vector search is fuzzy. It tolerates the typo and the inflection, and in return
it will happily hand you three paragraphs that are roughly on topic when the
exact answer was right there.

Fusion is what makes the pair worth the trouble. From the eval set in
`eval/dataset.json`, eighteen queries written the way colleagues actually type
them, against twelve help desk documents:

```
support-desk: 12 documents, 12 chunks, 18 queries, embedder ngram-3-256

mode      recall@1  recall@3  recall@5     mrr   missed
--------  --------  --------  --------  ------  -------
lexical      67%       89%       94%   0.773        1
vector       50%       89%       94%   0.690        1
hybrid       72%      100%      100%   0.843        0
```

Neither arm answers every query. Together they do. Run it yourself with
`npm run eval`; it uses an in-memory Postgres, so the numbers above come out
the same on any machine.

## The embedder

The default embedder hashes character trigrams into a 256-wide vector. It is
not a semantic model and it is not pretending to be one. What it buys is a
second opinion that survives a typo, a compound written as two words or an
inflected ending, with no network call, no key and no cold start, which is why
the tests and the eval run anywhere.

For real semantic matching, point `EMBEDDER=http` at anything that speaks the
OpenAI embeddings shape and set `EMBED_MODEL` and `EMBED_DIMENSIONS`. The
embedder is an interface; the rest of the system does not know the difference.
Each chunk records which embedder wrote its vector, so a search never compares
vectors from two different models.

## Running it

```
docker compose up
```

That brings up Postgres with pgvector, applies the migrations and serves the
API on port 8080. Without Docker:

```
npm ci
export DATABASE_URL=postgres://localhost/docsearch
export DOCSEARCH_TOKEN=some-long-random-string
npm run build
node dist/bin.js migrate
node dist/bin.js serve
```

## The API

Everything except `/healthz` wants `Authorization: Bearer $DOCSEARCH_TOKEN`.

| route | what it does |
| --- | --- |
| `GET /healthz` | document and chunk counts, no token needed |
| `POST /documents` | store a document, replacing any with the same `id`; 201 or 200 |
| `GET /documents/:id` | metadata and chunk count |
| `DELETE /documents/:id` | remove the document and its chunks |
| `POST /search` | `query`, and optionally `limit`, `candidates`, `mode`, `filter`, `rrfK` |

`examples/demo.ts` starts the API against an in-memory Postgres, loads the eval
corpus and makes these calls. Its output, verbatim:

```
$ POST /search {"query":"warrenty on belts","limit":2}
200
{
  "query": "warrenty on belts",
  "mode": "hybrid",
  "hits": [
    {
      "chunkId": 2,
      "documentId": 2,
      "externalId": "warranty",
      "title": "Warranty terms",
      "source": null,
      "position": 0,
      "text": "Every machine carries a two year warranty against manufacturing defects. The warranty does not cover wear parts such as belts, filters and blades, nor damage from use outside the manual. ...",
      "start": 0,
      "end": 353,
      "score": 0.03278688524590164,
      "ranks": {
        "lexical": 1,
        "vector": 1
      }
    },
    {
      "chunkId": 3,
      "documentId": 3,
      "externalId": "invoicing",
      "title": "Invoicing and payment terms",
      "source": null,
      "position": 0,
      "text": "Invoices are sent by email on the day the order ships, with thirty days to pay. ...",
      "start": 0,
      "end": 298,
      "score": 0.016129032258064516,
      "ranks": {
        "vector": 2
      }
    }
  ],
  "considered": {
    "lexical": 1,
    "vector": 12
  },
  "tookMs": 9.1
}
```

`ranks` is there so a hit can be explained: this one was first on both lists,
the second was found only by the vector arm. `start` and `end` are offsets into
the document you sent, so the hit can be shown in its own context rather than
as a floating snippet.

Use `filter` to scope a search to part of the corpus. It is matched with the
`@>` operator against the metadata you stored, so `{"team": "finance"}` only
considers documents ingested with that key.

## Settings

| variable | default | meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string |
| `DOCSEARCH_TOKEN` | unset | bearer token; unset means every caller is let in |
| `PORT` | `8080` | |
| `TEXT_SEARCH_CONFIG` | `english` | Postgres text search configuration, `swedish` and the rest work |
| `EMBEDDER` | `ngram` | `ngram` or `http` |
| `EMBED_DIMENSIONS` | `256` | must match the column; changing it needs a fresh schema |
| `EMBED_URL`, `EMBED_MODEL`, `EMBED_API_KEY` | | for `EMBEDDER=http` |
| `CHUNK_MAX_CHARS` | `900` | |
| `CHUNK_OVERLAP_CHARS` | `150` | |

## Details worth knowing

**Chunking follows the text.** Paragraphs first, then sentences, then words,
and only when a single word is longer than the limit does a chunk break
mid-word. Each chunk carries its offsets into the original, and overlap is
snapped forward to a word boundary so a chunk never opens mid-word.

**Lexical matching ORs the query.** `plainto_tsquery` joins every word with
AND, so one word the document happens not to use drops it entirely. The query
is stemmed and the lexemes are ORed instead, and `ts_rank_cd` decides the
order. On the eval set that is the difference between 28% and 67% recall@1.

**Ingest is one transaction.** The embeddings are fetched first, then the
document row, the delete of the old chunks and the insert of the new ones all
go in together. An embedding backend that falls over leaves the previous
version of the document in place rather than half of the new one.

**The schema is generated from your settings.** The vector column width comes
from the embedder and the `tsvector` expression from the text search
configuration, both substituted into `migrations/001_schema.sql` after being
checked against a strict pattern. Nothing else is interpolated anywhere; every
other value goes in as a parameter.

**Tests run against real Postgres.** 106 of them, no services and no network,
because [PGlite](https://pglite.dev) runs Postgres 16 with pgvector in process.
The SQL in the tests is the SQL that runs in production.

## Limits

- One embedding model per database. The width is fixed at migration time, and
  chunks record which model wrote them, so switching means a new schema and a
  re-ingest.
- No reranker. The result of fusion is the result.
- No incremental re-chunking. Ingesting a document again replaces all of its
  chunks.
- `ts_rank_cd` is not BM25. It is what Postgres gives you without an extension,
  and it is the weaker half of why fusion helps here.

MIT licensed.
