-- Ground truth schema for the BIS RAG assistant.
-- Applied automatically on server start / ingest (idempotent, see src/db.js).

create extension if not exists vector;

create table if not exists bis_chunks (
    id           bigserial primary key,
    doc_id       text        not null,
    doc_title    text        not null,
    page_from    int         not null,
    page_to      int         not null,
    clause       text,
    chunk_index  int         not null,
    content      text        not null,
    embedding    vector(768) not null,
    created_at   timestamptz not null default now()
);

-- One row per ingested document, so /api/health can report coverage and so
-- re-ingesting a PDF can replace its chunks in one statement.
create table if not exists bis_documents (
    doc_id      text primary key,
    doc_title   text        not null,
    source_file text        not null,
    page_count  int         not null,
    chunk_count int         not null,
    is_scanned  boolean     not null default false,
    ingested_at timestamptz not null default now()
);

-- HNSW cosine index. Note the 768-dim ceiling: pgvector HNSW/IVFFlat cannot
-- index vectors wider than 2000 dims, so the 3072-dim Gemini default is unusable
-- here. With a small corpus an exact scan is fine too, but the index costs nothing.
create index if not exists bis_chunks_embedding_hnsw
    on bis_chunks
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- Retrieval is a pure vector scan, so this btree is not on the hot path; it keeps
-- the per-document bookkeeping in the ingest path fast.
create index if not exists bis_chunks_doc_id_idx on bis_chunks (doc_id);
