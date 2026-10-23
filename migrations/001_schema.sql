CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id          bigserial PRIMARY KEY,
    external_id text        NOT NULL UNIQUE,
    title       text        NOT NULL,
    source      text,
    body        text        NOT NULL,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_metadata_idx ON documents USING gin (metadata jsonb_path_ops);

CREATE TABLE chunks (
    id           bigserial PRIMARY KEY,
    document_id  bigint    NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    position     integer   NOT NULL,
    body         text      NOT NULL,
    start_offset integer   NOT NULL,
    end_offset   integer   NOT NULL,
    embedder     text      NOT NULL,
    embedding    vector(:dimensions) NOT NULL,
    lexeme       tsvector  GENERATED ALWAYS AS (to_tsvector(':tsconfig', body)) STORED,
    UNIQUE (document_id, position)
);

CREATE INDEX chunks_lexeme_idx ON chunks USING gin (lexeme);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_document_idx ON chunks (document_id);
