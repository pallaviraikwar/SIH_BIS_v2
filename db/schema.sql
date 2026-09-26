-- Ground truth schema for the BIS RAG assistant.
-- Applied automatically on server start / ingest (idempotent, see src/db.js).
--
-- {{EMBED_DIMS}} is substituted from EMBED_DIMS at migrate time. The width used to
-- be hardcoded to 768 here while also being configurable in .env, which is two
-- sources of truth for one number and guaranteed to drift the first time somebody
-- changed the model.

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
    embedding    vector({{EMBED_DIMS}}) not null,
    created_at   timestamptz not null default now()
);

-- Which model produced the vectors currently stored, and how wide they are.
--
-- Vectors from different embedding models are not comparable, and a corpus that
-- mixes them retrieves garbage without raising anything: cosine distance across
-- two unrelated vector spaces is a meaningless number, so the symptom is quietly
-- worse answers rather than an error. This table is the guard. Startup compares it
-- against the configured provider and, on any mismatch, drops the index and asks
-- for a re-ingest, so a mixed index is not a state the system can be in.
create table if not exists bis_index_meta (
    id             int primary key default 1,
    embed_provider text not null,
    embed_model    text not null,
    dims           int  not null,
    updated_at     timestamptz not null default now(),
    constraint bis_index_meta_singleton check (id = 1)
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
    ingested_at timestamptz not null default now(),
    -- 'pending' while chunks are still being embedded, 'ready' once complete.
    --
    -- The free tier caps embedContent at 1000 requests/day, and a 929-page
    -- standard does not fit in one day's budget, so ingest persists each batch
    -- as it completes and can be resumed the next day. That makes half-written
    -- documents a real state, and a half-written document must never be cited,
    -- so every read path filters on status = 'ready'.
    status      text        not null default 'ready',
    -- How many of chunk_count have actually been embedded. Lets a resumed run
    -- skip work already paid for instead of paying for it twice.
    embedded_count int      not null default 0,
    -- Fingerprint of the extracted+chunked text. A resume only reuses stored
    -- chunks when this still matches, so editing a PDF cannot leave a mix of
    -- old and new chunks behind.
    content_hash text
);

-- `create table if not exists` is a no-op when the table already exists, so a
-- database created by an earlier version never picks up new columns. Each column
-- therefore also gets an idempotent ALTER, and anything that *depends* on a new
-- column has to come after them. This is the whole migration story: no version
-- table, no ordered steps, just re-runnable DDL in dependency order.
alter table bis_documents add column if not exists status         text not null default 'ready';
alter table bis_documents add column if not exists embedded_count int  not null default 0;
alter table bis_documents add column if not exists content_hash   text;

-- Rows written before incremental ingest existed are complete by definition, so
-- their progress counter must equal their chunk count. Without this backfill
-- finalizeDocument() would refuse to promote them.
update bis_documents set embedded_count = chunk_count where status = 'ready' and embedded_count = 0;

create index if not exists bis_documents_status_idx on bis_documents (status);

-- HNSW cosine index. Note the 768-dim ceiling: pgvector HNSW/IVFFlat cannot
-- index vectors wider than 2000 dims, so the 3072-dim Gemini default is unusable
-- here. With a small corpus an exact scan is fine too, but the index costs nothing.
create index if not exists bis_chunks_embedding_hnsw
    on bis_chunks
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- Incremental ingest re-runs appendChunks() for batches it may have already
-- written, so (doc_id, chunk_index) has to be unique for the upsert to be
-- idempotent. Without it a resumed run silently doubles up chunks and every
-- citation points at the wrong text.
--
-- Dedupe first: an older build had no uniqueness, so a resumed ingest may already
-- have left pairs behind. Keep the lowest id, which is the first one written.
delete from bis_chunks a using bis_chunks b
 where a.doc_id = b.doc_id
   and a.chunk_index = b.chunk_index
   and a.id > b.id;

create unique index if not exists bis_chunks_doc_chunk_uniq
    on bis_chunks (doc_id, chunk_index);

-- Retrieval is a pure vector scan, so this btree is not on the hot path; it keeps
-- the per-document bookkeeping in the ingest path fast. Superseded by the unique
-- index above, which has the same leading column.
create index if not exists bis_chunks_doc_id_idx on bis_chunks (doc_id);

-- Keyword arm of hybrid retrieval.
--
-- Vectors match meaning and fail on identifiers. Measured on this corpus with
-- nomic-embed-text, a bare "IS 456" scores 0.546 — below the 0.67 answer bar —
-- because an embedding has no way to treat "456" as an identifier rather than a
-- quantity, and a number carries almost no meaning on its own. That is a
-- different failure from a misspelling and it is fixable with a lexical index.
--
-- What this index does: whole-word and identifier matching, GIN-indexed and fast.
-- "IS 456" and "clay paving bricks" match exactly.
--
-- What it deliberately does not do is catch misspellings, and no trigram arm was
-- kept for that. It was built and measured, and it does not work here:
-- `word_similarity('brks', content)` returns an identical 0.600 against
-- "Tolerances", "thermocouple" and "Acoustical materials" alike, because on a
-- 765-character chunk the best-matching *word extent* is an incidental four-
-- character coincidence. Its recall on "cemnt" was 0.667 for "solvent cement",
-- "polyester resin" and "PVC fittings" — eight rows, all confidently wrong, all
-- ranked as if they were matches. A retriever that returns wrong text with a
-- high score is worse than one that returns nothing, so it was removed rather
-- than tuned. Misspelled queries are handled by the bridge band instead, which
-- shows the nearest real clause and says plainly that it is not a match.
--
-- 'simple' is deliberate. The default 'english' config stems and drops stop words,
-- which is wrong for this corpus: the vocabulary is dense with material and product
-- names ("water", "sand", "stone", "cold", "hard") that a stemmer would strip or
-- conflate, and clause references like "6.1" need to match literally.
--
-- A generated column, so the indexed text is derived from the stored text by
-- Postgres itself and the two cannot drift.
alter table bis_chunks add column if not exists search_tsv tsvector
    generated always as (to_tsvector('simple', doc_title || ' ' || content)) stored;

create index if not exists bis_chunks_tsv_idx on bis_chunks using gin (search_tsv);
