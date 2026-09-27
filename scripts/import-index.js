import { config, assertConfig } from '../src/config.js';
import { pool, migrate, closePool } from '../src/db.js';
import {
  resolveBundleDir,
  readManifest,
  readNdjsonGz,
  validateBundle,
  pdfReport,
  summarisePdfs,
  humanBytes,
  DOCUMENTS_FILE,
  CHUNKS_FILE,
  SNAPSHOT_DIR,
} from '../src/snapshot.js';

/**
 * Load a prepared index bundle instead of running ingest.
 *
 *   npm run index:import                 the bundle index-snapshots/LATEST names
 *   npm run index:import -- --dir PATH   a specific bundle
 *   npm run index:import -- --replace    overwrite whatever is in the store
 *
 * Ingest on CPU takes 5-20 minutes for a few thousand chunks. This takes seconds,
 * and it is the reason the bundle format exists: the vectors are the expensive
 * part and they do not depend on the machine that loads them.
 *
 * The order of the checks below is the design, not an accident:
 *
 *   1. resolve the bundle and read its manifest
 *   2. verify both files against the checksums in that manifest
 *   3. compare the manifest against .env, and refuse
 *   4. compare the store against the bundle, and refuse or ask
 *   5. migrate (creates the schema, writes bis_index_meta from .env)
 *   6. upsert documents, then chunks
 *   7. verify the counts, analyse, report on the PDFs
 *
 * Nothing touches the database until step 5, and step 5 is the first step that
 * can delete anything. Steps 1-4 exist so that the destructive step is only ever
 * reached by a bundle that has already been proven compatible.
 */

/** Rows per INSERT. 100 keeps each statement around 1 MB of vector literal. */
const BATCH = 100;

/**
 * Progress on one rewritten line, but only on a terminal.
 *
 * A carriage return moves the cursor; piped into a file or a CI log it writes
 * every update as its own line, which turns a 51-batch import into 51 lines of
 * noise. `isTTY` is the check, and it is worth doing because the output of this
 * script is exactly the thing somebody pastes into a bug report.
 */
const TTY = Boolean(process.stdout.isTTY);
function progress(label, done, total) {
  if (TTY) {
    process.stdout.write(`\r[import]   ${label} ${done}/${total}`);
  } else if (done === total || done % (BATCH * 10) === 0) {
    console.log(`[import]   ${label} ${done}/${total}`);
  }
}
function progressDone() {
  if (TTY) process.stdout.write('\n');
}

const USAGE = `Usage: npm run index:import -- [options]

  --dir PATH    load PATH instead of the bundle index-snapshots/LATEST names
  --replace     delete the existing index first (needed when the store holds a
                different embedding model than the bundle)
  -h, --help    this text

A bundle is refused if its embedding provider, model or width differs from .env.
To rebuild from the PDFs instead:  npm run ingest:force`;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = { dir: null, replace: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' || a === '-d') {
      if (i + 1 >= argv.length) {
        console.error('--dir needs a path');
        process.exit(1);
      }
      opts.dir = argv[++i];
    } else if (a.startsWith('--dir=')) {
      opts.dir = a.slice('--dir='.length);
    } else if (a === '--replace' || a === '-r') {
      opts.replace = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      console.error(`unknown option: ${a}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- store state

/**
 * What is already in the store, or null if it has never been migrated.
 *
 * Written to tolerate a database that does not exist yet: this is the first
 * thing a fresh install runs, and "the schema is not there" is the expected
 * answer, not a failure.
 */
async function probeStore() {
  const { rows } = await pool.query(
    `select to_regclass('bis_index_meta') is not null as has_meta,
            to_regclass('bis_chunks')     is not null as has_chunks`
  );
  const { has_meta: hasMeta, has_chunks: hasChunks } = rows[0];
  if (!hasMeta || !hasChunks) return null;

  const meta = await pool.query('select * from bis_index_meta where id = 1');
  const counts = await pool.query(
    `select (select count(*)::int from bis_chunks)     as chunks,
            (select count(*)::int from bis_documents) as docs`
  );
  return { fingerprint: meta.rows[0] ?? null, ...counts.rows[0] };
}

const sameFingerprint = (fp, embed) =>
  Boolean(fp) &&
  fp.embed_provider === embed.provider &&
  fp.embed_model === embed.model &&
  Number(fp.dims) === Number(embed.dims);

// ---------------------------------------------------------------- checks

async function reportCheck({ manifest, store, embed, replace }) {
  if (!store) {
    console.log('[import] store:  empty (no schema yet) — this will be a first-time import');
    return { proceed: true };
  }

  const storeChunks = store.chunks ?? 0;
  if (storeChunks === 0) {
    console.log('[import] store:  present but empty — this will be a first-time import');
    return { proceed: true };
  }

  console.log(
    `[import] store:  ${storeChunks} chunk(s) in ${store.docs} document(s), ` +
      `${store.fingerprint ? store.fingerprint.embed_provider + '/' + store.fingerprint.embed_model + ' (' + store.fingerprint.dims + ' dims)' : 'no fingerprint'}`
  );

  if (!sameFingerprint(store.fingerprint, embed)) {
    if (!replace) {
      console.error(
        '\n[import] Refusing: the store holds an index built by a different embedding model than\n' +
          '         this bundle. Vectors from two models are not comparable — importing over the\n' +
          '         top would leave a corpus that answers confidently and wrongly.\n' +
          '         Pass --replace to delete the existing index and load this bundle, or run\n' +
          '         `npm run ingest:force` to rebuild the current model from the PDFs.'
      );
      return { proceed: false };
    }
    console.log('[import] --replace: the existing index will be deleted');
    return { proceed: true, replace: true };
  }

  // Same fingerprint, so an import is an upsert and re-running is harmless. The
  // one thing upsert cannot do is remove: a document in the store but not in the
  // bundle stays, and its chunks stay, and it will be cited.
  const storeDocs = (await pool.query('select doc_id from bis_documents')).rows.map((r) => r.doc_id);
  const bundleDocs = new Set((manifest.documents ?? []).map((d) => d.docId));
  const orphans = storeDocs.filter((id) => !bundleDocs.has(id));
  if (orphans.length) {
    console.log(
      `[import] note: the store holds ${orphans.length} document(s) this bundle does not have. They\n` +
        `         will be left alone, not deleted: ${orphans.slice(0, 3).join(', ')}` +
        `${orphans.length > 3 ? `, +${orphans.length - 3} more` : ''}. Pass --replace for a clean store.`
    );
  }
  console.log(`[import] same embedding model, so this is an upsert. Existing rows are updated in place.`);
  return { proceed: true, replace: replace === true };
}

// ---------------------------------------------------------------- writes

/**
 * Upsert documents, then chunks.
 *
 * `on conflict (doc_id, chunk_index)` rather than on the primary key, and that is
 * not a detail: the unique index on (doc_id, chunk_index) is what makes a resumed
 * ingest safe, so leaning on the same key is what makes this safe to re-run.
 * The `id` bigserial is left to the database on every path, which is why the
 * bundle does not carry one.
 *
 * `ingested_at` is set to the bundle's `createdAt`, not to now(). A loaded
 * corpus should still report when it was actually built — /api/documents exposes
 * that column, and stamping it with the import time would look exactly like a
 * fresh ingest of these PDFs, which it is not.
 */
async function loadBundle(documents, chunks, createdAt) {
  console.log(`[import] writing ${documents.length} document(s)…`);
  for (let i = 0; i < documents.length; i += BATCH) {
    const batch = documents.slice(i, i + BATCH);
    const values = [];
    const params = [];
    for (const [n, d] of batch.entries()) {
      // 10 columns, so the stride is 10. Writing 9 here is the kind of mistake
      // that only shows up as "supplies 50 parameters, but requires 46" on the
      // first batch, which is at least a loud failure rather than a wrong index.
      const o = n * 10;
      values.push(
        `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`
      );
      params.push(
        d.doc_id,
        d.doc_title,
        d.source_file ?? '',
        d.page_count ?? 0,
        d.chunk_count ?? 0,
        Boolean(d.is_scanned),
        d.status ?? 'ready',
        d.embedded_count ?? d.chunk_count ?? 0,
        d.content_hash ?? null,
        d.ingested_at ?? createdAt
      );
    }
    await pool.query(
      `insert into bis_documents
         (doc_id, doc_title, source_file, page_count, chunk_count, is_scanned,
          status, embedded_count, content_hash, ingested_at)
       values ${values.join(',')}
       on conflict (doc_id) do update set
         doc_title      = excluded.doc_title,
         source_file    = excluded.source_file,
         page_count     = excluded.page_count,
         chunk_count    = excluded.chunk_count,
         is_scanned     = excluded.is_scanned,
         status         = excluded.status,
         embedded_count = excluded.embedded_count,
         content_hash   = excluded.content_hash,
         ingested_at    = excluded.ingested_at`,
      params
    );
    progress('documents', Math.min(i + BATCH, documents.length), documents.length);
  }
  progressDone();

  console.log(`[import] writing ${chunks.length} chunk(s)…`);
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const values = [];
    const params = [];
    for (const [n, c] of batch.entries()) {
      const o = n * 8;
      values.push(
        `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`
      );
      params.push(
        c.doc_id,
        c.doc_title,
        c.page_from,
        c.page_to,
        c.clause ?? null,
        c.chunk_index,
        c.content,
        c.embedding
      );
    }
    await pool.query(
      `insert into bis_chunks
         (doc_id, doc_title, page_from, page_to, clause, chunk_index, content, embedding)
       values ${values.join(',')}
       on conflict (doc_id, chunk_index) do update set
         doc_title = excluded.doc_title,
         page_from = excluded.page_from,
         page_to   = excluded.page_to,
         clause    = excluded.clause,
         content   = excluded.content,
         embedding = excluded.embedding`,
      params
    );
    progress('chunks   ', Math.min(i + BATCH, chunks.length), chunks.length);
  }
  progressDone();
}

/**
 * Prove the rows landed, rather than assuming they did.
 *
 * Counted over the bundle's own document ids, not over the whole table: the store
 * may legitimately hold documents this bundle does not know about, and comparing
 * a global count against the bundle would then report a false failure on a
 * correct import. What must hold is that every document the bundle promised is
 * present with the chunk count it promised.
 */
async function verifyLoad(docIds, expectedChunks, expectedDocs) {
  if (!docIds.length) return { ok: true, chunks: 0, docs: 0 };

  const { rows } = await pool.query(
    `select count(*)::int                                        as docs,
            coalesce(sum(chunk_count), 0)::int                   as chunks,
            count(*) filter (where status <> 'ready')::int        as not_ready
       from bis_documents
      where doc_id = any($1::text[])`,
    [docIds]
  );
  const got = rows[0];
  const problems = [];
  if (got.docs !== expectedDocs) {
    problems.push(`${got.docs} of ${expectedDocs} document(s) are in the store`);
  }
  if (got.chunks !== expectedChunks) {
    problems.push(`bis_documents claims ${got.chunks} chunk(s), the bundle has ${expectedChunks}`);
  }
  if (got.not_ready) {
    problems.push(
      `${got.not_ready} document(s) are not status 'ready', and every read path filters on that, ` +
        'so they would be invisible to retrieval'
    );
  }

  const { rows: actual } = await pool.query(
    'select count(*)::int as n from bis_chunks where doc_id = any($1::text[])',
    [docIds]
  );
  if (actual[0].n !== expectedChunks) {
    problems.push(`bis_chunks holds ${actual[0].n} row(s) for these documents, the bundle has ${expectedChunks}`);
  }

  return { ok: problems.length === 0, problems, chunks: got.chunks, docs: got.docs };
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

let exitCode = 0;

try {
  assertConfig();

  const bundleDir = await resolveBundleDir(opts.dir, { rootDir: SNAPSHOT_DIR });
  if (!bundleDir) {
    console.error(
      `[import] no bundle to load.\n` +
        `         Looked for ${SNAPSHOT_DIR}/LATEST` +
        (opts.dir ? ` and for ${opts.dir}` : '') +
        '.\n' +
        '         To build one from a machine that has an index:  npm run index:export\n' +
        '         To build one from the PDFs instead:            npm run ingest'
    );
    exitCode = 1;
  } else {
    // ---- 1. manifest
    let manifest;
    try {
      manifest = await readManifest(bundleDir);
    } catch (err) {
      console.error(`[import] cannot read ${bundleDir}: ${err.message}`);
      exitCode = 1;
      manifest = null;
    }

    if (manifest) {
      // What this bundle claims, before anything is verified or written. Printed
      // first so the reader knows what they are being asked to trust before they
      // are asked to trust it.
      console.log(`[import] bundle: ${bundleDir}`);
      console.log(
        `[import] built:  ${manifest.createdAt}  ${manifest.embed.provider}/${manifest.embed.model} ` +
          `(${manifest.embed.dims} dims), ${manifest.corpus.chunkCount} chunks in ${manifest.corpus.docCount} documents`
      );

      // ---- 3. against .env, before the database is touched at all
      const check = validateBundle(manifest, {
        embedding: {
          provider: config.embedding.provider,
          model: config.embedding.model,
          dims: config.embedding.dims,
          prefixTitle: config.embedding.prefixTitle,
        },
        chunk: { chars: config.chunk.chars, overlap: config.chunk.overlap, minSealChars: config.chunk.minSealChars },
      });

      for (const w of check.warnings) console.log(`[import] warning: ${w}`);

      if (!check.ok) {
        console.error(
          `\n[import] Refusing this bundle. ${check.errors.length} problem(s):\n` +
            check.errors.map((e) => `  - ${e}`).join('\n') +
            '\n\n         This is the same guard bis_index_meta applies, one step earlier: vectors from\n' +
            '         two different embedding models are not comparable, and a corpus that mixes\n' +
            '         them answers with confidence and no signal that anything is wrong.\n' +
            '         To build an index for this machine from the PDFs:  npm run ingest:force'
        );
        exitCode = 1;
      } else {
        // ---- 2. checksums
        let documents;
        let chunks;
        try {
          console.log('[import] verifying checksums…');
          [documents, chunks] = await Promise.all([
            readNdjsonGz(bundleDir, DOCUMENTS_FILE, manifest.files?.[DOCUMENTS_FILE]),
            readNdjsonGz(bundleDir, CHUNKS_FILE, manifest.files?.[CHUNKS_FILE]),
          ]);
          console.log(
            `[import]   ${humanBytes((manifest.files?.[CHUNKS_FILE]?.bytes ?? 0) + (manifest.files?.[DOCUMENTS_FILE]?.bytes ?? 0))} verified`
          );
        } catch (err) {
          console.error(`\n[import] ${err.message}`);
          exitCode = 1;
        }

        if (documents && chunks) {
          // ---- 4. against the store
          const store = await probeStore();
          const verdict = await reportCheck({
            manifest,
            store,
            embed: {
              provider: manifest.embed.provider,
              model: manifest.embed.model,
              dims: manifest.embed.dims,
            },
            replace: opts.replace,
          });

          if (!verdict.proceed) {
            exitCode = 1;
          } else {
            // ---- 5. schema. First step that can write.
            await migrate();
            console.log('[import] schema ready, bis_index_meta written from .env');

            if (verdict.replace) {
              console.log('[import] deleting the existing index…');
              await pool.query('delete from bis_chunks');
              await pool.query('delete from bis_documents');
            }

            // ---- 6. rows
            const started = Date.now();
            await loadBundle(documents, chunks, manifest.createdAt);
            console.log(`[import] loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

            // ---- 7. verify, analyse, report
            const docIds = documents.map((d) => d.doc_id);
            const verdict2 = await verifyLoad(docIds, chunks.length, documents.length);
            if (!verdict2.ok) {
              console.error(
                '[import] FAILED verification — do not trust this index:\n' +
                  verdict2.problems.map((p) => `  - ${p}`).join('\n')
              );
              exitCode = 1;
            } else {
              console.log(
                `[import] verified: ${chunks.length} chunk(s) across ${documents.length} document(s)` +
                  (verdict2.docs > documents.length ? '' : '')
              );
            }

            // The planner has never seen these rows, so it is working off stale
            // statistics. One statement, and the HNSW build would have been far
            // more expensive.
            await pool.query('analyze bis_chunks');
            await pool.query('analyze bis_documents');
            console.log('[import] analysed the tables');

            const report = await pdfReport(manifest, config.corpus.pdfDir);
            console.log('');
            for (const line of summarisePdfs(report)) console.log(`[import] ${line}`);

            if (exitCode === 0) {
              console.log('\n[import] done. Start the app and it answers from this index immediately.');
            }
          }
        }
      }
    }
  }
} catch (err) {
  console.error(`[import] failed: ${err.message}`);
  if (err.code === 'ECONNREFUSED') {
    console.error(
      '[import] the vector store is not reachable at ' +
        `${config.db.connectionString.replace(/:[^:@/]*@/, ':***@')}. Is it up?  npm run db:up`
    );
  }
  exitCode = 1;
} finally {
  await closePool().catch(() => {});
}

process.exit(exitCode);
