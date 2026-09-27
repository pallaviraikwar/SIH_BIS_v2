import fs from 'node:fs/promises';
import path from 'node:path';
import { config, assertConfig } from '../src/config.js';
import { pool, closePool } from '../src/db.js';
import {
  buildManifest,
  bundleDirName,
  writeNdjsonGz,
  sha256,
  humanBytes,
  DOCUMENTS_FILE,
  CHUNKS_FILE,
  MANIFEST_FILE,
  LATEST_FILE,
  SNAPSHOT_DIR,
} from '../src/snapshot.js';

/**
 * Export the vector index to a portable bundle, so somebody installing this
 * project can have a working corpus without re-embedding it.
 *
 *   npm run index:export                 -> index-snapshots/<stamp>-<model>-<dims>/
 *   npm run index:export -- --out DIR    -> DIR instead
 *
 * Why this is not `pg_dump`: the reasoning is at the top of src/snapshot.js. The
 * short version is that a dump cannot be checked against the local .env before
 * it is restored, and an index built by a different embedding model is worse than
 * no index at all — it retrieves confidently and wrongly.
 *
 * What is NOT in the bundle is the source PDFs. They are BIS standards and not
 * ours to redistribute, so each document's filename and sha256 are recorded and
 * the file itself is not. The import reports exactly which citation links that
 * will cost.
 */

const USAGE = `Usage: npm run index:export -- [options]

  --out DIR     write the bundle to DIR instead of index-snapshots/
  --force       overwrite the bundle directory if a manifest is already in it
  -h, --help    this text

The bundle name is also recorded in index-snapshots/LATEST, which is what
\`npm run index:import\` reads when it is given no directory.`;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = { out: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') {
      if (i + 1 >= argv.length) {
        console.error('--out needs a directory');
        process.exit(1);
      }
      opts.out = argv[++i];
    } else if (a.startsWith('--out=')) {
      opts.out = a.slice('--out='.length);
    } else if (a === '--force' || a === '-f') {
      opts.force = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      console.error(`unknown option: ${a}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- helpers

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * sha256 of a PDF on disk, or null when it is not there.
 *
 * Best effort: this runs on a machine that may not have the corpus at all, and a
 * missing file is the normal case for a machine whose only job is to export.
 * Recorded anyway, so the importer can tell "different PDF" from "no PDF" — two
 * problems with two different fixes.
 */
async function hashPdf(pdfDir, sourceFile) {
  if (!sourceFile) return null;
  try {
    const buf = await fs.readFile(path.join(pdfDir, sourceFile));
    return { bytes: buf.length, sha256: sha256(buf) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- export

async function exportBundle({ out, force }) {
  assertConfig();

  const rootDir = out
    ? path.resolve(process.cwd(), out)
    : path.join(process.cwd(), SNAPSHOT_DIR);
  const embed = {
    provider: config.embedding.provider,
    model: config.embedding.model,
    dims: config.embedding.dims,
    prefixTitle: config.embedding.prefixTitle,
  };
  const bundleDir = path.join(rootDir, bundleDirName({ embed }));

  if ((await exists(path.join(bundleDir, MANIFEST_FILE))) && !force) {
    console.error(`[export] ${bundleDir} already has a manifest. Pass --force to overwrite.`);
    process.exit(1);
  }

  // The fingerprint comes from the store, not from .env.
  //
  // These are not always the same, and when they differ the store is the truth:
  // bis_index_meta records what actually produced the vectors in the table.
  // Exporting under the .env model instead would write a manifest that describes
  // the vectors wrongly, and the importer — which only ever compares a manifest
  // to its own config — would wave those vectors straight through.
  const { rows: metaRows } = await pool.query('select * from bis_index_meta where id = 1');
  const meta = metaRows[0];
  if (!meta) {
    console.error(
      '[export] bis_index_meta is empty, so nothing has ever been ingested into this store.\n' +
        '         Run `npm run ingest` first, or start the database:  npm run db:up'
    );
    process.exit(1);
  }

  console.log(`[export] store fingerprint: ${meta.embed_provider}/${meta.embed_model} (${meta.dims} dims)`);
  console.log(
    `[export] configured:        ${config.embedding.provider}/${config.embedding.model} ` +
      `(${config.embedding.dims} dims)`
  );
  if (meta.embed_provider !== config.embedding.provider || meta.embed_model !== config.embedding.model) {
    console.error(
      '\n[export] Refusing: .env does not match the store, so the manifest could not describe these\n' +
        '         vectors honestly. Either point .env at the model the store was built with, or\n' +
        `         re-embed:  EMBED_MODEL=${meta.embed_model} npm run ingest:force`
    );
    process.exit(1);
  }

  const { rows: docs } = await pool.query(
    `select doc_id, doc_title, source_file, page_count, chunk_count, is_scanned, status
       from bis_documents
      order by doc_id`
  );
  const { rows: chunks } = await pool.query(
    `select doc_id, doc_title, page_from, page_to, clause, chunk_index, content,
            embedding::text as embedding
       from bis_chunks
      order by doc_id, chunk_index`
  );

  if (!chunks.length) {
    console.error('[export] bis_chunks is empty — there is nothing to export.');
    process.exit(1);
  }

  // `id` and `created_at` are deliberately absent from both files. The id is a
  // bigserial that means nothing outside this database, and letting the import
  // renumber is what keeps a bundle restorable into a store that already holds
  // other rows. created_at is superseded by the manifest's createdAt.
  const documents = [];
  for (const d of docs) {
    documents.push({
      doc_id: d.doc_id,
      doc_title: d.doc_title,
      source_file: d.source_file,
      page_count: d.page_count,
      chunk_count: d.chunk_count,
      is_scanned: d.is_scanned,
      status: d.status,
      // Restored as fully embedded. Every read path filters on
      // status = 'ready', so a document left 'pending' would be invisible to
      // retrieval while its chunks sat in the table — a corpus that reports
      // chunks and cites nothing.
      embedded_count: d.chunk_count,
      pdf: await hashPdf(config.corpus.pdfDir, d.source_file),
    });
  }

  await fs.mkdir(bundleDir, { recursive: true });

  // A bundle that failed halfway is worse than no bundle: it is a directory that
  // looks loadable, and the next export picks a different timestamp so nobody
  // notices the broken one is still there. Removed on the way out of here.
  let written = false;
  try {
    console.log(`[export] writing ${documents.length} document row(s)…`);
    const docFile = await writeNdjsonGz(path.join(bundleDir, DOCUMENTS_FILE), documents);

    console.log(`[export] writing ${chunks.length} chunk(s) with their vectors…`);
    const chunkFile = await writeNdjsonGz(path.join(bundleDir, CHUNKS_FILE), chunks);

    const manifest = buildManifest({
      embed: {
        ...embed,
        provider: meta.embed_provider,
        model: meta.embed_model,
        dims: Number(meta.dims),
      },
      chunking: {
        chars: config.chunk.chars,
        overlap: config.chunk.overlap,
        minSealChars: config.chunk.minSealChars,
      },
      documents,
      chunkCount: chunks.length,
      files: { [DOCUMENTS_FILE]: docFile, [CHUNKS_FILE]: chunkFile },
    });

    // The manifest is written LAST, and it is the marker a directory is
    // recognised by. So a bundle is only ever "loadable" once it is complete —
    // an interrupted run leaves files with no manifest, which --force and
      // resolveBundleDir both treat as not-a-bundle.
    await fs.writeFile(
      path.join(bundleDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    written = true;

    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, LATEST_FILE), `${path.basename(bundleDir)}\n`);

    const manifestSize = (await fs.stat(path.join(bundleDir, MANIFEST_FILE))).size;
    const total = docFile.bytes + chunkFile.bytes + manifestSize;
    const hashed = documents.filter((d) => d.pdf).length;

    console.log(`\n[export] ${bundleDir}`);
    console.log(
      `[export]   ${manifest.corpus.chunkCount} chunks, ${manifest.corpus.docCount} documents, ` +
        `${manifest.corpus.pageCount} pages  (${humanBytes(total)} gzipped)`
    );
    console.log(
      `[export]   ${hashed}/${documents.length} source PDFs found and hashed — the files themselves ` +
        'are not in the bundle'
    );
    console.log(
      '\n[export] To load this on another machine, copy that one directory into its\n' +
        '         index-snapshots/ folder, then run:  npm run index:import'
    );
    return 0;
  } finally {
    if (!written) {
      await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

let code = 0;
try {
  code = await exportBundle(opts);
} catch (err) {
  console.error(`[export] failed: ${err.message}`);
  if (err.code === 'ECONNREFUSED') {
    console.error(
      '[export] the vector store is not reachable at ' +
        `${config.db.connectionString.replace(/:[^:@/]*@/, ':***@')}. Is it up?  npm run db:up`
    );
  }
  code = 1;
} finally {
  await closePool().catch(() => {});
}
process.exit(code);
