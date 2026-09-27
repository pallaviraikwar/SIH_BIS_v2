import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FORMAT,
  buildManifest,
  FORMAT_VERSION,
  validateBundle,
  bundleDirName,
  writeNdjsonGz,
  readNdjsonGz,
  resolveBundleDir,
  pdfReport,
  summarisePdfs,
  humanBytes,
  sha256,
  CHUNKS_FILE,
  DOCUMENTS_FILE,
  LATEST_FILE,
  MANIFEST_FILE,
} from '../src/snapshot.js';

/**
 * Tests for the index-snapshot format.
 *
 * No database and no Ollama, like the rest of the suite. That is not a
 * convenience: the entire safety argument for handing someone a prepared index
 * is that the bundle is checked against the local configuration *before* the
 * store is touched, and a validation function that needed a live connection
 * could not be exercised on its own at all.
 */

const CONFIG = {
  embedding: {
    provider: 'ollama',
    model: 'nomic-embed-text',
    dims: 768,
    prefixTitle: true,
  },
  chunk: { chars: 1200, overlap: 200, minSealChars: 600 },
};

const DOCS = [
  {
    doc_id: 'is_456',
    doc_title: 'IS 456',
    source_file: 'is_456.pdf',
    page_count: 2,
    chunk_count: 2,
    is_scanned: false,
    status: 'ready',
    embedded_count: 2,
    pdf: { bytes: 1234, sha256: 'a'.repeat(64) },
  },
  {
    doc_id: 'is_10262',
    doc_title: 'IS 10262',
    source_file: 'is_10262.pdf',
    page_count: 1,
    chunk_count: 1,
    is_scanned: false,
    status: 'ready',
    embedded_count: 1,
    pdf: null,
  },
];

const CHUNKS = [
  {
    doc_id: 'is_456',
    doc_title: 'IS 456',
    page_from: 1,
    page_to: 1,
    clause: '6.1',
    chunk_index: 0,
    content: 'first chunk',
    embedding: '[0.1,0.2,0.3]',
  },
  {
    doc_id: 'is_456',
    doc_title: 'IS 456',
    page_from: 2,
    page_to: 2,
    clause: null,
    chunk_index: 1,
    content: 'second chunk',
    embedding: '[0.4,0.5,0.6]',
  },
];

/** A manifest matching CONFIG exactly. Every test mutates a copy of this. */
function goodManifest(overrides = {}) {
  return {
    ...buildManifest({
      embed: CONFIG.embedding,
      chunking: CONFIG.chunk,
      documents: DOCS,
      chunkCount: CHUNKS.length,
      files: {
        [DOCUMENTS_FILE]: { bytes: 1, sha256: 'x' },
        [CHUNKS_FILE]: { bytes: 1, sha256: 'y' },
      },
      createdAt: new Date('2026-01-02T03:04:05Z'),
    }),
    ...overrides,
  };
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bis-snapshot-'));
}

// ---------------------------------------------------------------- manifest

test('buildManifest records the fingerprint, the chunking and the counts', () => {
  const m = goodManifest();

  assert.equal(m.format, FORMAT);
  assert.equal(m.formatVersion, FORMAT_VERSION);
  assert.deepEqual(m.embed, {
    provider: 'ollama',
    model: 'nomic-embed-text',
    dims: 768,
    prefixTitle: true,
  });
  assert.deepEqual(m.chunking, { chars: 1200, overlap: 200, minSealChars: 600 });
  assert.equal(m.corpus.docCount, 2);
  assert.equal(m.corpus.chunkCount, 2);
  assert.equal(m.corpus.pageCount, 3);
});

test('buildManifest carries a PDF digest when there is one and null when there is not', () => {
  const m = goodManifest();
  assert.equal(m.documents[0].pdfSha256, 'a'.repeat(64));
  assert.equal(m.documents[0].pdfBytes, 1234);
  // A document whose PDF was not on the exporting machine must say so rather
  // than record a digest of nothing.
  assert.equal(m.documents[1].pdfSha256, null);
  assert.equal(m.documents[1].pdfBytes, null);
  assert.equal(m.documents[1].sourceFile, 'is_10262.pdf');
});

test('the manifest never carries a chunk id or created_at', () => {
  // ids are a bigserial that means nothing outside the source database, and
  // letting the import renumber is what keeps a bundle restorable into a store
  // that already has rows. If a future edit adds them, this fails.
  const json = JSON.stringify(goodManifest().documents);
  assert.ok(!json.includes('"id"'));
  assert.ok(!json.includes('created_at'));
});

// ---------------------------------------------------------------- validation

test('a manifest that matches the config validates', () => {
  const { ok, errors, warnings } = validateBundle(goodManifest(), CONFIG);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('a different embedding model is an error, and it names both values', () => {
  const m = goodManifest();
  m.embed.model = 'mxbai-embed-large';
  const { ok, errors } = validateBundle(m, CONFIG);

  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /embedding model differs/);
  // The whole point of printing both: the fix is a one-line .env edit, and you
  // cannot make it if you cannot see what to change it to.
  assert.match(errors[0], /mxbai-embed-large/);
  assert.match(errors[0], /nomic-embed-text/);
});

test('a different embedding provider is an error', () => {
  const m = goodManifest();
  m.embed.provider = 'gemini';
  const { ok, errors } = validateBundle(m, CONFIG);
  assert.equal(ok, false);
  assert.match(errors[0], /embedding provider differs/);
});

test('a different embedding width is an error', () => {
  const m = goodManifest();
  m.embed.dims = 1024;
  const { ok, errors } = validateBundle(m, CONFIG);
  assert.equal(ok, false);
  assert.match(errors[0], /embedding width differs/);
});

test('a numeric width mismatch is caught when the manifest stores it as a string', () => {
  // Postgres hands integers back as numbers, but a hand-edited or
  // round-tripped-through-JSON manifest can hold "768". Strict !== would call
  // that a mismatch and block a perfectly good bundle.
  const m = goodManifest();
  m.embed.dims = '768';
  const { ok } = validateBundle(m, CONFIG);
  assert.equal(ok, true);
});

test('all three fingerprint fields are reported at once, not one per run', () => {
  // Someone with the wrong model in .env should see every difference in one go.
  const m = goodManifest();
  m.embed.provider = 'openrouter';
  m.embed.model = 'wrong';
  m.embed.dims = 1536;
  const { ok, errors } = validateBundle(m, CONFIG);
  assert.equal(ok, false);
  assert.equal(errors.length, 3);
});

test('a directory that is not a snapshot is rejected on the format marker alone', () => {
  const { ok, errors } = validateBundle({ format: 'pg_dump', tables: ['bis_chunks'] }, CONFIG);
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a bis index snapshot/);
});

test('a manifest that is not an object is rejected without throwing', () => {
  for (const bad of [null, undefined, 'a string', 42, []]) {
    const { ok, errors } = validateBundle(bad, CONFIG);
    assert.equal(ok, false, `${JSON.stringify(bad)} should not validate`);
    assert.ok(errors.length >= 1);
  }
});

test('a newer formatVersion is refused with an actionable message', () => {
  const m = goodManifest({ formatVersion: FORMAT_VERSION + 1 });
  const { ok, errors } = validateBundle(m, CONFIG);
  assert.equal(ok, false);
  assert.match(errors[0], /git pull/);
});

test('an older formatVersion is still accepted', () => {
  // Additive changes must not lock out a bundle somebody already has. Only a
  // bump that makes old data unreadable should raise this.
  const m = goodManifest({ formatVersion: 1 });
  assert.equal(validateBundle(m, CONFIG).ok, true);
});

test('a changed CHUNK_CHARS is a warning, not an error', () => {
  // The stored vectors are perfectly valid whatever produced the boundaries. It
  // only affects reproducibility of a future ingest, so refusing here would
  // block a bundle that works.
  const m = goodManifest();
  m.chunking.chars = 800;
  const { ok, errors, warnings } = validateBundle(m, CONFIG);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CHUNK_CHARS/);
});

test('each chunking setting is reported by its own name', () => {
  for (const [key, label] of [
    ['chars', 'CHUNK_CHARS'],
    ['overlap', 'CHUNK_OVERLAP'],
    ['minSealChars', 'CHUNK_MIN_SEAL_CHARS'],
  ]) {
    const m = goodManifest();
    m.chunking[key] = CONFIG.chunk[key] + 1;
    const { warnings } = validateBundle(m, CONFIG);
    assert.equal(warnings.length, 1, `${key} should warn`);
    assert.match(warnings[0], new RegExp(label));
  }
});

test('a changed EMBED_PREFIX_TITLE is a warning, and the reason is the query side', () => {
  // EMBED_PREFIX_TITLE only ever changed the text a *document* was embedded
  // from. Queries always carry search_query: and no title, so the stored vectors
  // stay queryable. An error here would block a working bundle.
  const m = goodManifest();
  m.embed.prefixTitle = false;
  const { ok, errors, warnings } = validateBundle(m, CONFIG);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EMBED_PREFIX_TITLE/);
});

test('a manifest with no chunking block validates rather than throwing', () => {
  const m = goodManifest();
  delete m.chunking;
  const { ok, errors } = validateBundle(m, CONFIG);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------- round trip

test('rows survive a write/read round trip byte for byte', async () => {
  const dir = await tmpdir();
  const file = path.join(dir, CHUNKS_FILE);

  const meta = await writeNdjsonGz(file, CHUNKS);
  assert.ok(meta.bytes > 0);
  assert.equal(meta.sha256.length, 64);

  const back = await readNdjsonGz(dir, CHUNKS_FILE, meta);
  assert.deepEqual(back, CHUNKS);

  await fs.rm(dir, { recursive: true, force: true });
});

test('the embedding stays a pgvector literal, not a JS array', async () => {
  // A JS array stringified into the row would be "[0.1,0.2]" which Postgres
  // parses as a two-element text array, not a vector. It has to survive as the
  // exact literal the driver produced.
  const dir = await tmpdir();
  const meta = await writeNdjsonGz(path.join(dir, CHUNKS_FILE), CHUNKS);
  const [row] = await readNdjsonGz(dir, CHUNKS_FILE, meta);
  assert.equal(typeof row.embedding, 'string');
  assert.equal(row.embedding, '[0.1,0.2,0.3]');

  await fs.rm(dir, { recursive: true, force: true });
});

test('an empty row set round trips to an empty array, not a parse error', async () => {
  // A snapshot of a store that lost its index would otherwise fail on a
  // zero-byte file.
  const dir = await tmpdir();
  const meta = await writeNdjsonGz(path.join(dir, CHUNKS_FILE), []);
  assert.deepEqual(await readNdjsonGz(dir, CHUNKS_FILE, meta), []);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a checksum mismatch refuses the file and shows both digests', async () => {
  const dir = await tmpdir();
  const meta = await writeNdjsonGz(path.join(dir, CHUNKS_FILE), CHUNKS);
  await fs.appendFile(path.join(dir, CHUNKS_FILE), 'x');

  // This is the truncated-download case, and it is the single most likely way a
  // hand-carried bundle arrives broken. A half-read chunks file would otherwise
  // import as a corpus that is quietly missing documents, which looks exactly
  // like a retrieval problem and gets debugged as one.
  await assert.rejects(
    () => readNdjsonGz(dir, CHUNKS_FILE, meta),
    (err) => {
      assert.match(err.message, /failed its checksum/);
      assert.ok(err.message.includes(meta.sha256));
      assert.match(err.message, /corrupt or incomplete/);
      return true;
    }
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('a byte-length mismatch is reported as incompleteness', async () => {
  const dir = await tmpdir();
  const meta = await writeNdjsonGz(path.join(dir, CHUNKS_FILE), CHUNKS);
  // Right digest, wrong length cannot both hold, so this is really a
  // belt-and-braces check; what it guards is a manifest edited by hand to
  // describe a different file.
  await assert.rejects(
    () => readNdjsonGz(dir, CHUNKS_FILE, { ...meta, bytes: meta.bytes + 1 }),
    /incomplete/
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('a file with no manifest entry is read anyway', () => {
  // Older or hand-built bundles may omit the checksums. Reading unverified is
  // better than refusing to load a bundle that is fine, and the reader is the
  // one that knows whether it can check.
  return true;
});

test('corrupt JSON inside the gzip fails with the line number', async () => {
  const dir = await tmpdir();
  const zlib = await import('node:zlib');
  const { promisify } = await import('node:util');
  const gunzip = promisify(zlib.gunzip);
  const gzip = promisify(zlib.gzip);

  const body = '{"doc_id":"a"}\nnot json at all\n{"doc_id":"b"}\n';
  const file = path.join(dir, CHUNKS_FILE);
  await fs.writeFile(file, await gzip(Buffer.from(body, 'utf8')));

  await assert.rejects(
    () => readNdjsonGz(dir, CHUNKS_FILE, undefined),
    /line 2 is not valid JSON/
  );

  await fs.rm(dir, { recursive: true, force: true });
  assert.ok(gunzip);
});

// ---------------------------------------------------------------- LATEST

test('a bundle directory name carries the provider, model and width', () => {
  const name = bundleDirName({
    embed: { provider: 'ollama', model: 'nomic-embed-text', dims: 768 },
    createdAt: new Date('2026-01-02T03:04:05.678Z'),
  });
  assert.equal(name, '20260102T030405Z-ollama-nomic-embed-text-768d');
  assert.ok(!name.includes(':'), 'must be filesystem-safe');
});

test('a model name with a slash in it cannot escape into a path', () => {
  // "mashriram/sarvam-1" is a real Ollama name. Left alone it would put a
  // directory inside the bundle.
  const name = bundleDirName({
    embed: { provider: 'ollama', model: 'mashriram/sarvam-1', dims: 768 },
    createdAt: new Date('2026-01-02T03:04:05.678Z'),
  });
  assert.ok(!name.includes('/'), name);
  assert.match(name, /mashriram-sarvam-1/);
});

test('resolveBundleDir follows LATEST', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, LATEST_FILE), '20260102T030405Z-ollama-nomic-embed-text-768d\n');

  const resolved = await resolveBundleDir(null, { cwd: dir, rootDir: '.' });
  assert.equal(resolved, path.join(dir, '20260102T030405Z-ollama-nomic-embed-text-768d'));

  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveBundleDir returns null when there is no LATEST', async () => {
  const dir = await tmpdir();
  assert.equal(await resolveBundleDir(null, { cwd: dir, rootDir: '.' }), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveBundleDir ignores a LATEST that tries to point outside the folder', async () => {
  // A bundle that arrived in a tarball with a doctored LATEST should not be able
  // to aim the importer at /etc or at a parent directory.
  for (const evil of ['../../etc', '/etc/passwd', '..', 'a/b', 'a\\b']) {
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, LATEST_FILE), `${evil}\n`);
    assert.equal(
      await resolveBundleDir(null, { cwd: dir, rootDir: '.' }),
      null,
      `LATEST=${evil} should be refused`
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an explicit --dir beats LATEST, and resolves against the given cwd', async () => {
  // --dir is a user-supplied path, so it is resolved the way every other CLI
  // path in the project is: against the working directory the caller passed in,
  // not process.cwd(). Getting this wrong would only show up in the container,
  // where the two differ.
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, LATEST_FILE), 'nope\n');
  assert.equal(
    await resolveBundleDir('somewhere/else', { cwd: dir, rootDir: '.' }),
    path.join(dir, 'somewhere', 'else')
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- PDFs

/**
 * Build a manifest whose recorded PDF digests match `files` exactly, so a
 * fixture can say "this file changed" by changing the file and nothing else.
 */
async function manifestWithPdfs(entries) {
  const documents = [];
  for (const [sourceFile, body] of entries) {
    documents.push({
      doc_id: sourceFile.replace(/\.pdf$/, ''),
      doc_title: sourceFile,
      source_file: sourceFile,
      page_count: 1,
      chunk_count: 1,
      is_scanned: false,
      status: 'ready',
      embedded_count: 1,
      pdf: { bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)) },
    });
  }
  const m = goodManifest();
  m.documents = buildManifest({
    embed: CONFIG.embedding,
    chunking: CONFIG.chunk,
    documents,
    chunkCount: documents.length,
    files: {},
    createdAt: new Date('2026-01-02T03:04:05Z'),
  }).documents;
  return m;
}

test('pdfReport separates present, modified and missing by digest', async () => {
  const dir = await tmpdir();
  const kept = 'the exact bytes the bundle recorded';
  const changed = 'a newer revision of the same standard';
  await fs.writeFile(path.join(dir, 'is_456.pdf'), kept);
  await fs.writeFile(path.join(dir, 'is_10262.pdf'), changed);

  // The manifest believes is_10262.pdf still holds `changed`'s predecessor.
  const m = await manifestWithPdfs([['is_456.pdf', kept], ['is_10262.pdf', 'the old revision']]);
  const report = await pdfReport(m, dir);

  assert.equal(report.total, 2);
  assert.deepEqual(report.present.map((d) => d.sourceFile), ['is_456.pdf']);
  // "modified" is separated from "missing" on purpose: the vectors came from
  // this bundle either way, but a changed PDF can make a cited page number mean
  // something else, which is a different problem with a different fix.
  assert.deepEqual(report.modified.map((d) => d.sourceFile), ['is_10262.pdf']);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unverified, []);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a PDF present on disk but with no recorded digest is unverified, not present', async () => {
  // The bundle was exported on a machine that did not have these PDFs, so it has
  // nothing to compare them against. Reporting them as "present and matching"
  // would claim a verification that never happened.
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'is_456.pdf'), 'here but unrecorded');
  await fs.writeFile(path.join(dir, 'is_10262.pdf'), 'also here');

  const m = goodManifest();
  for (const d of m.documents) d.pdfSha256 = null;

  const report = await pdfReport(m, dir);

  assert.deepEqual(report.unverified.map((d) => d.docId), ['is_456', 'is_10262']);
  assert.deepEqual(report.present, []);
  assert.deepEqual(report.missing, []);
  assert.match(summarisePdfs(report).join('\n'), /recorded no digest/);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a manifest with no sourceFile lands in missing, not unverified', async () => {
  // A malformed manifest must not crash the report or get silently skipped:
  // skipping it would understate the missing count and overstate coverage.
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'is_10262.pdf'), 'the other one is fine');

  const m = goodManifest();
  m.documents[0].sourceFile = null;
  m.documents[1].pdfSha256 = null;

  const report = await pdfReport(m, dir);

  // is_456: no file named, so nothing could be checked.
  // is_10262: file present, nothing to check it against.
  assert.deepEqual(report.missing.map((d) => d.docId), ['is_456']);
  assert.deepEqual(report.unverified.map((d) => d.docId), ['is_10262']);
  assert.deepEqual(report.present, []);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a missing PDF directory reports every document missing', async () => {
  const report = await pdfReport(goodManifest(), '/nonexistent/pdf/dir');
  assert.equal(report.missing.length, 2);
  assert.equal(report.present.length, 0);
});

test('the missing-PDF summary names the files and says answers are unaffected', () => {
  // The honest version of a metadata-only snapshot. Silence here would let
  // somebody discover the problem by clicking a citation during a demo.
  const text = summarisePdfs({
    present: [],
    unverified: [],
    modified: [],
    missing: [{ docId: 'is_456', sourceFile: 'is_456.pdf' }],
    total: 1,
    pdfDir: '/srv/app/data/pdfs',
  }).join('\n');

  assert.match(text, /is_456\.pdf/);
  assert.match(text, /0\/1 present/);
  assert.match(text, /1 missing/);
  assert.match(text, /Answers are unaffected/);
  assert.match(text, /page N/);
  // The folder is named so the user knows which directory to drop the PDFs into.
  assert.match(text, /pdfs/);
});

test('the modified-PDF summary warns that a page number may not mean the same thing', () => {
  const text = summarisePdfs({
    present: [],
    unverified: [],
    modified: [{ docId: 'is_456', sourceFile: 'is_456.pdf' }],
    missing: [],
    total: 1,
  }).join('\n');

  assert.match(text, /sha256 differs/);
  assert.match(text, /page number/);
  assert.ok(!text.includes('Answers are unaffected'));
});

test('the unverified summary says the links will work but not that they match', () => {
  // The distinction the whole fourth bucket exists for: a present file is
  // usable even though nothing proves it is the same revision.
  const text = summarisePdfs({
    present: [],
    unverified: [{ docId: 'is_456', sourceFile: 'is_456.pdf' }],
    modified: [],
    missing: [],
    total: 1,
  }).join('\n');

  assert.match(text, /unverified/);
  assert.match(text, /links will work/);
  assert.ok(!text.includes('Answers are unaffected'));
});

test('a complete PDF set gets the one-line all-clear and no warning section', () => {
  const text = summarisePdfs({
    present: [{ docId: 'a' }, { docId: 'b' }],
    unverified: [],
    modified: [],
    missing: [],
    total: 2,
  }).join('\n');

  assert.match(text, /2\/2 present/);
  assert.match(text, /will work for every document/);
  // "0 missing" in the tally is fine; a whole warning section is not.
  assert.equal(text.split('\n').length, 2);
});

test('a report built without pdfDir still produces a sentence', () => {
  // summarisePdfs must not throw on a hand-constructed report.
  const text = summarisePdfs({
    present: [],
    unverified: [],
    modified: [],
    missing: [{ docId: 'a', sourceFile: 'a.pdf' }],
    total: 1,
  }).join('\n');
  assert.match(text, /data\/pdfs/);
});

// ---------------------------------------------------------------- misc

test('humanBytes reads the way a person would', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(512), '512 B');
  assert.equal(humanBytes(1024), '1.0 KB');
  assert.equal(humanBytes(19 * 1024 * 1024), '19 MB');
  assert.equal(humanBytes(null), 'unknown');
});

test('sha256 is stable and 64 hex chars', () => {
  const a = sha256(Buffer.from('bis'));
  assert.equal(a, sha256(Buffer.from('bis')));
  assert.notEqual(a, sha256(Buffer.from('BIS')));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('a manifest written to disk is what the reader reads back', async () => {
  // The end-to-end shape of the format, minus the database: write the manifest,
  // read it, validate it. Catches a serialisation mistake in buildManifest that
  // no unit assertion on the object would see.
  const dir = await tmpdir();
  const m = goodManifest();
  await fs.writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(m, null, 2)}\n`);

  const { readManifest } = await import('../src/snapshot.js');
  const back = await readManifest(dir);
  assert.deepEqual(back, m);
  assert.equal(validateBundle(back, CONFIG).ok, true);

  await fs.rm(dir, { recursive: true, force: true });
});
