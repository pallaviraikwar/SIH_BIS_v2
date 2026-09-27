import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * The index-snapshot format: export, import, and the guard that stands between
 * a bundle and a database.
 *
 * Everything in this file is deliberately free of `pg`. The whole safety
 * argument for the feature is that a bundle is checked against the local
 * configuration *before* anything is written, and a check that needs a live
 * database connection is a check that cannot run early enough to be useful. So
 * the format, its validation, and the file plumbing live here and take plain
 * objects; only scripts/import-index.js touches the store.
 *
 * Format
 * ------
 *   index-snapshots/
 *     LATEST                          one line: the directory name to load
 *     <stamp>-<provider>-<model>-<N>d/
 *       manifest.json                 fingerprint, counts, checksums, PDF digests
 *       documents.jsonl.gz            one bis_documents row per line
 *       chunks.jsonl.gz               one bis_chunks row per line, vectors included
 *
 * NDJSON and gzip because it streams in both directions and needs no schema to
 * read: someone who receives a bundle can see exactly what is in it with `zcat`.
 *
 * `LATEST` is a text file, not a symlink. This directory is the artefact that
 * gets zipped and carried between machines by hand, and a symlink is destroyed
 * by `zip`, by Windows, and by most Windows filesystems.
 */

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

/** The marker. A directory without it is not a bundle. */
export const FORMAT = 'bis-index-snapshot';

/**
 * Bumped only when an older bundle becomes unreadable, never for additive
 * changes — so a newer project can still read an older bundle, which is the
 * whole reason for versioning separately from FORMAT.
 */
export const FORMAT_VERSION = 1;

export const DOCUMENTS_FILE = 'documents.jsonl.gz';
export const CHUNKS_FILE = 'chunks.jsonl.gz';
export const MANIFEST_FILE = 'manifest.json';
export const LATEST_FILE = 'LATEST';

/** Where bundles live, relative to the project root. */
export const SNAPSHOT_DIR = 'index-snapshots';

// ---------------------------------------------------------------- digests

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function humanBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ---------------------------------------------------------------- names

/**
 * Directory name for a new bundle.
 *
 * The provider, model and width are in the name because several of these will
 * end up on one machine, and picking the wrong one is a refusal at import time
 * that reads like a bug. The name settles it before anything is opened.
 */
export function bundleDirName({ embed, createdAt = new Date() }) {
  const stamp = createdAt.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const model = String(embed.model).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${stamp}-${embed.provider}-${model}-${embed.dims}d`;
}

/**
 * Which bundle to load: the one named, or whatever LATEST points at.
 *
 * LATEST is preferred over "newest directory by mtime" on purpose. Directory
 * mtime changes when a file inside is touched, `ls -t` is not stable across
 * filesystems, and a half-copied bundle could win that race. A named pointer
 * only ever points at something that was complete when it was written.
 */
export async function resolveBundleDir(explicit, { cwd = process.cwd(), rootDir = null } = {}) {
  const base = path.resolve(cwd, rootDir ?? SNAPSHOT_DIR);

  if (explicit) return path.resolve(cwd, explicit);

  let pointer;
  try {
    pointer = (await fs.readFile(path.join(base, LATEST_FILE), 'utf8')).trim();
  } catch {
    return null;
  }
  if (!pointer) return null;

  // A pointer is a single directory name. Refuse anything with a path separator
  // rather than resolving it: a bundle that arrived in a tarball with a
  // doctored LATEST should not be able to point the importer at /etc.
  if (pointer.includes('/') || pointer.includes('\\') || pointer === '..') return null;

  return path.join(base, pointer);
}

// ---------------------------------------------------------------- manifest

/**
 * Assemble a manifest from plain values.
 *
 * Pure so it can be tested without a database, which is the only way the
 * "what does a bundle claim about itself" questions get asked at all.
 */
export function buildManifest({
  embed,
  chunking,
  documents,
  chunkCount,
  files,
  createdAt = new Date(),
}) {
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: createdAt.toISOString(),
    embed: {
      provider: embed.provider,
      model: embed.model,
      dims: Number(embed.dims),
      prefixTitle: Boolean(embed.prefixTitle),
    },
    chunking: {
      chars: chunking.chars,
      overlap: chunking.overlap,
      minSealChars: chunking.minSealChars,
    },
    corpus: {
      docCount: documents.length,
      chunkCount,
      pageCount: documents.reduce((n, d) => n + (Number(d.page_count) || 0), 0),
    },
    documents: documents.map((d) => ({
      docId: d.doc_id,
      docTitle: d.doc_title,
      sourceFile: d.source_file,
      pageCount: d.page_count,
      chunkCount: d.chunk_count,
      pdfBytes: d.pdf?.bytes ?? null,
      pdfSha256: d.pdf?.sha256 ?? null,
    })),
    files,
  };
}

/**
 * Compare a bundle's claims against the local configuration.
 *
 * Returns errors and warnings rather than throwing, because the caller has to
 * print all of them at once — someone with the wrong model in `.env` wants to
 * see every difference in one go, not one per run.
 *
 * The line between the two lists is the important part:
 *
 *   errors    the vectors are not comparable with what this machine will
 *             produce, or the file is not a bundle this code understands.
 *             Importing anyway produces a corpus that retrieves confidently and
 *             wrongly, with nothing reporting a problem — the exact failure
 *             bis_index_meta exists to prevent, one step earlier.
 *
 *   warnings  the vectors are perfectly good but were produced under different
 *             settings than .env has now. Retrieval will work. What changes is
 *             reproducibility: a later `npm run ingest` on this machine would
 *             cut the same document into different chunks, so the two halves of
 *             the index would not agree with each other.
 */
export function validateBundle(manifest, { embedding, chunk }) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['the manifest is not a JSON object'], warnings };
  }

  if (manifest.format !== FORMAT) {
    errors.push(
      `format is ${JSON.stringify(manifest.format)}, expected ${JSON.stringify(FORMAT)}. ` +
        'This directory is not a bis index snapshot.'
    );
    // Everything below reads fields that a non-snapshot will not have, and the
    // format error is the one that matters. Stop here.
    return { ok: false, errors, warnings };
  }

  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) {
    errors.push(`formatVersion is ${JSON.stringify(manifest.formatVersion)}, expected a positive integer.`);
  } else if (manifest.formatVersion > FORMAT_VERSION) {
    errors.push(
      `formatVersion ${manifest.formatVersion} is newer than this build understands ` +
        `(${FORMAT_VERSION}). Update the project with:  git pull`
    );
  }

  const e = manifest.embed ?? {};
  const c = embedding ?? {};

  if (e.provider !== c.provider) {
    errors.push(
      `embedding provider differs: bundle has ${JSON.stringify(e.provider)}, ` +
        `.env has ${JSON.stringify(c.provider)}.`
    );
  }
  if (e.model !== c.model) {
    errors.push(
      `embedding model differs: bundle has ${JSON.stringify(e.model)}, ` +
        `.env has ${JSON.stringify(c.model)}.`
    );
  }
  if (Number(e.dims) !== Number(c.dims)) {
    errors.push(
      `embedding width differs: bundle has ${Number(e.dims)}, .env has ${Number(c.dims)}. ` +
        'The bis_chunks.embedding column is sized from .env, so these rows would not even fit.'
    );
  }

  // Below here: real, but not fatal.
  if (e.prefixTitle !== undefined && Boolean(e.prefixTitle) !== Boolean(c.prefixTitle)) {
    // Only a warning, and the reason is specific: EMBED_PREFIX_TITLE changes the
    // text a *document* is embedded from, never the text a query is embedded
    // from. Queries carry search_query: and no title whatever the setting, so
    // the stored vectors remain queryable and correct.
    warnings.push(
      `EMBED_PREFIX_TITLE is ${Boolean(c.prefixTitle)} here and was ${Boolean(e.prefixTitle)} ` +
        'when the bundle was built. Retrieval still works — this only ever affected the ' +
        'document side of the embedding — but a fresh ingest here would produce ' +
        'slightly different vectors for the same text.'
    );
  }

  const k = manifest.chunking ?? {};
  for (const [key, label] of [
    ['chars', 'CHUNK_CHARS'],
    ['overlap', 'CHUNK_OVERLAP'],
    ['minSealChars', 'CHUNK_MIN_SEAL_CHARS'],
  ]) {
    if (k[key] !== undefined && Number(k[key]) !== Number(chunk?.[key])) {
      warnings.push(
        `${label} is ${chunk?.[key]} here and was ${k[key]} when the bundle was built. ` +
          'The stored vectors are still valid; a re-ingest would cut the same pages differently.'
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------- files

export async function readManifest(bundleDir) {
  const raw = await fs.readFile(path.join(bundleDir, MANIFEST_FILE), 'utf8');
  return JSON.parse(raw);
}

/**
 * Read one gzipped NDJSON file, verifying its checksum.
 *
 * The checksum is the point. A bundle that travelled by email, a USB stick or a
 * truncated download is the single most likely way this feature gets used, and a
 * half-read chunks file would otherwise import as a corpus that is quietly
 * missing documents — which looks exactly like a retrieval problem and gets
 * debugged as one.
 */
export async function readNdjsonGz(bundleDir, name, expected) {
  const file = path.join(bundleDir, name);
  const raw = await fs.readFile(file);

  if (expected) {
    const actual = sha256(raw);
    if (actual !== expected.sha256) {
      throw new Error(
        `${name} failed its checksum.\n` +
          `  expected sha256 ${expected.sha256}\n` +
          `  actual   sha256 ${actual}\n` +
          '  The file is corrupt or incomplete. Copy the bundle again — do not import it.'
      );
    }
    if (expected.bytes != null && raw.length !== expected.bytes) {
      throw new Error(
        `${name} is ${raw.length} bytes, the manifest says ${expected.bytes}. ` +
          'The bundle is incomplete. Copy it again.'
      );
    }
  }

  const text = (await gunzip(raw)).toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (err) {
      throw new Error(`${name} line ${rows.length + 1} is not valid JSON: ${err.message}`);
    }
  }
  return rows;
}

/** gzipped NDJSON from rows, plus the bytes/sha256 pair for the manifest. */
export async function writeNdjsonGz(filePath, rows) {
  const body = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  const buf = await gzip(Buffer.from(body, 'utf8'), { level: 9 });
  await fs.writeFile(filePath, buf);
  return { bytes: buf.length, sha256: sha256(buf) };
}

// ---------------------------------------------------------------- PDFs

/**
 * Compare the bundle's PDF digests against what is actually on disk.
 *
 * This is the report that makes a metadata-only bundle honest. The bundle holds
 * no PDFs — they are BIS standards and not ours to redistribute — so on a
 * machine that has not got the corpus, every answer is correctly grounded and
 * every citation link 404s. That is a visible, explainable state rather than a
 * broken one, and it is worth four distinct outcomes:
 *
 *   present     the file is there and its digest matches
 *   unverified  the file is there, but the bundle recorded no digest for it, so
 *               "there" is all that can be claimed. This happens when the
 *               exporting machine did not have the PDF either. Folding it into
 *               `present` would report an all-clear the data does not support.
 *   modified    the file is there but the digest differs — the PDF on disk is not
 *               the one these vectors were built from, so a cited *page number*
 *               may not be where the passage now is
 *   missing     no file at all, so clicking the citation cannot work
 */
export async function pdfReport(manifest, pdfDir) {
  const out = { present: [], unverified: [], modified: [], missing: [], total: 0, pdfDir };

  for (const d of manifest?.documents ?? []) {
    out.total++;
    if (!d.sourceFile) {
      out.missing.push(d);
      continue;
    }
    let buf;
    try {
      buf = await fs.readFile(path.join(pdfDir, d.sourceFile));
    } catch {
      out.missing.push(d);
      continue;
    }
    if (!d.pdfSha256) out.unverified.push(d);
    else if (sha256(buf) !== d.pdfSha256) out.modified.push(d);
    else out.present.push(d);
  }

  return out;
}

/** One-paragraph summary of a pdfReport, for printing. */
export function summarisePdfs(report) {
  const { present, unverified, modified, missing, total } = report;
  // Falls back to the literal because the report carries its own pdfDir, and a
  // caller that built a report by hand should still get a sentence.
  const where = report.pdfDir ? path.basename(report.pdfDir) || report.pdfDir : 'data/pdfs';
  const lines = [];

  if (total === 0) {
    return ['The bundle lists no documents, so there is nothing to check.'];
  }

  lines.push(
    `PDFs: ${present.length}/${total} present and matching` +
      `${unverified.length ? `, ${unverified.length} unverified` : ''}` +
      `${modified.length ? `, ${modified.length} modified` : ''}` +
      `${missing.length ? `, ${missing.length} missing` : ''}.`
  );

  if (missing.length) {
    lines.push(
      `  ${missing.length} document(s) have no PDF in ${where}, so clicking a citation for them will not`
    );
    lines.push('  open anything:');
    for (const d of missing) lines.push(`    - ${d.sourceFile}  (${d.docId})`);
    lines.push(
      '  Answers are unaffected — retrieval reads the vectors, not the file. Only the'
    );
    lines.push('  "open the source at page N" link needs the PDF.');
  }
  if (modified.length) {
    lines.push(
      `  ${modified.length} document(s) are present but their sha256 differs from the bundle. These are`
    );
    lines.push(
      '  probably a newer revision of the same standard: the answers come from the bundle, but'
    );
    lines.push('  a cited page number may not mean the same thing in your copy.');
    for (const d of modified) lines.push(`    - ${d.sourceFile}  (${d.docId})`);
  }
  if (unverified.length) {
    lines.push(
      `  ${unverified.length} document(s) are present, but the bundle recorded no digest for them,`
    );
    lines.push('  so they are unverified rather than confirmed. The links will work.');
    for (const d of unverified) lines.push(`    - ${d.sourceFile}  (${d.docId})`);
  }
  if (!missing.length && !modified.length && !unverified.length) {
    lines.push('  Citation links will work for every document.');
  }

  return lines;
}
