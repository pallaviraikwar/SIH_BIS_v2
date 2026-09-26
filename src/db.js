import fs from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// A single pool for the whole process. max is deliberately small: this is a
// single-user demo and each request only needs one connection.
export const pool = new Pool({
  connectionString: config.db.connectionString,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // A pooled client can die while idle (e.g. container restart). Log and let the
  // pool replace it instead of crashing the process.
  console.error('[db] idle client error:', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Apply the schema, then make the stored index match the configured model.
 *
 * Two steps, and the second is the important one. `create table if not exists`
 * silently does nothing when the table already exists, so changing EMBED_DIMS
 * cannot be expressed in schema.sql at all — the column keeps its old width and
 * every insert fails with a vector dimension mismatch, or worse, succeeds against
 * a column that was never narrowed.
 */
export async function migrate() {
  const sql = await fs.readFile(config.corpus.schemaPath, 'utf8');
  await pool.query(sql.replaceAll('{{EMBED_DIMS}}', String(config.embedding.dims)));
  await syncIndexToConfig();
}

/** Current on-disk width of bis_chunks.embedding, or null if the table is absent. */
async function storedDims() {
  const { rows } = await pool.query(
    `select atttypmod as dims
       from pg_attribute
      where attrelid = 'bis_chunks'::regclass
        and attname = 'embedding'`
  );
  return rows[0]?.dims ?? null;
}

async function chunkCount() {
  const { rows } = await pool.query('select count(*)::int as n from bis_chunks');
  return rows[0].n;
}

/**
 * Refuse to run on an index that was built by a different embedding model.
 *
 * When the fingerprint differs, the stored vectors are worthless — not merely
 * stale, but incomparable with anything the current model produces. They are also
 * fully regenerable from the PDFs on disk, so the correct move is to drop them and
 * say so loudly. Keeping them "just in case" is worse: a partially re-embedded
 * corpus would answer some questions well and others not at all, with no signal
 * explaining why.
 */
export async function syncIndexToConfig() {
  const want = {
    embedProvider: config.embedding.provider,
    embedModel: config.embedding.model,
    dims: config.embedding.dims,
  };

  const { rows: metaRows } = await pool.query('select * from bis_index_meta where id = 1');
  const have = metaRows[0];

  const onDiskDims = await storedDims();
  const stored = have ? Number(have.dims) : null;

  const mismatch = have && (have.embed_provider !== want.embedProvider || have.embed_model !== want.embedModel);

  // Width has to change in the column type itself, which is a separate concern
  // from the fingerprint: the first run of a new width has no fingerprint yet.
  if (onDiskDims !== null && onDiskDims !== want.dims) {
    const n = await chunkCount();
    if (n > 0) {
      console.warn(
        `[db] embedding width ${onDiskDims} -> ${want.dims}: dropping ${n} stored chunk(s). ` +
          'Vectors of a different width are not comparable, and the PDFs are on disk to re-embed from.'
      );
      await pool.query('delete from bis_chunks');
      await pool.query('delete from bis_documents');
    }
    await pool.query(`alter table bis_chunks alter column embedding type vector(${want.dims})`);
    console.log(`[db] bis_chunks.embedding is now vector(${want.dims})`);
  }

  if (mismatch) {
    const n = await chunkCount();
    if (n > 0) {
      console.warn(
        `[db] embedding model changed ${have.embed_provider}/${have.embed_model} -> ` +
          `${want.embedProvider}/${want.embedModel}: dropping ${n} stored chunk(s). ` +
          'Run `npm run ingest` to rebuild the index.'
      );
      await pool.query('delete from bis_chunks');
      await pool.query('delete from bis_documents');
    }
  }

  await pool.query(
    `insert into bis_index_meta (id, embed_provider, embed_model, dims, updated_at)
     values (1, $1, $2, $3, now())
     on conflict (id) do update
       set embed_provider = excluded.embed_provider,
           embed_model = excluded.embed_model,
           dims = excluded.dims,
           updated_at = now()`,
    [want.embedProvider, want.embedModel, want.dims]
  );

  return want;
}

/**
 * pgvector expects a bare array literal like '[0.1,0.2,...]'. The pg driver
 * would otherwise try to parse a JS array into a Postgres array literal, which
 * loses precision and adds whitespace, so format it explicitly.
 */
export function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}

export async function closePool() {
  await pool.end();
}
