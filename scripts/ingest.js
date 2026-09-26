import fs from 'node:fs/promises';
import path from 'node:path';
import { config, assertConfig } from '../src/config.js';
import { migrate, closePool } from '../src/db.js';
import { embedDocuments } from '../src/gemini.js';
import { listPdfs, extractPdfPages, stripRunningHeads, titleFromFilename, refineTitleFromContent } from '../src/pdf.js';
import { chunkDocument, toEmbeddableText } from '../src/chunker.js';
import { replaceDocumentChunks, getCorpusStats, deleteDocument } from '../src/store.js';

/**
 * Ingestion batches. The Gemini free tier rate-limits hard, so batches stay
 * small and each one is individually retried with backoff (see gemini.js).
 */
const BATCH_SIZE = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Proactive throttle for embedding.
 *
 * The free tier allows 100 `embed_content` requests per minute, and that quota
 * counts every *item* in a batch, not every API call — so a 20-item batch
 * spends 20 of the 100. Retrying reactively is not enough: the run gets far
 * enough to write some documents, then dies on 429 partway through the rest
 * and leaves a half-ingested corpus plus a wall of error text.
 *
 * Pacing instead of hammering means the whole corpus goes in on the first run.
 * Headroom below the published 100 leaves room for the query path, which shares
 * the same model and quota.
 */
class EmbedPacer {
  constructor(itemsPerMinute = 90) {
    this.intervalMs = 60000 / itemsPerMinute;
    this.nextFreeAt = 0;
    this.waited = 0;
  }

  /** Reserve quota for `count` items, sleeping until they may be sent. */
  async reserve(count) {
    const now = Date.now();
    const earliest = Math.max(now, this.nextFreeAt);
    this.nextFreeAt = earliest + count * this.intervalMs;
    const wait = earliest - now;
    if (wait > 0) {
      this.waited += wait;
      await sleep(wait);
    }
  }
}

/**
 * Below these, there is no text layer worth indexing.
 *
 * A strict `totalChars === 0` test is not enough: a scanned PDF can still yield
 * a stray page number or a watermark ("listofproducts.pdf" produces 14
 * characters across 22 blank pages), and ingesting that produces one junk chunk
 * that retrieval will happily surface.
 */
const MIN_CHARS_PER_PAGE = 20;
const MIN_TOTAL_CHARS = 200;

function docIdFromPath(file) {
  return path.basename(file, path.extname(file)).toLowerCase();
}

async function ingestOne(file, { existing = null, force = false, pacer = null } = {}) {
  const sourceFile = path.basename(file);
  const docId = docIdFromPath(file);

  const { pages, totalPages, totalChars, sparsePages, isScanned } = await extractPdfPages(file);

  const avgCharsPerPage = totalPages > 0 ? totalChars / totalPages : 0;

  if (totalChars < MIN_TOTAL_CHARS || avgCharsPerPage < MIN_CHARS_PER_PAGE) {
    console.log(
      `  ✗ ${sourceFile}: no usable text layer — ${totalChars} chars over ${totalPages} page(s) ` +
        `(${avgCharsPerPage.toFixed(0)} chars/page). Likely a pure scan. Skipped.`
    );
    return { skipped: true, reason: 'no_text_layer' };
  }

  if (isScanned) {
    console.log(
      `  ⚠ ${sourceFile}: ${sparsePages}/${totalPages} pages have no text layer. ` +
        'This looks like a scanned document; retrieval quality will be poor until it is OCR-ed.'
    );
  }

  const cleaned = stripRunningHeads(pages);
  const docTitle = refineTitleFromContent(titleFromFilename(file), cleaned);

  const chunks = chunkDocument({ docId, docTitle, pages: cleaned });
  if (!chunks.length) {
    console.log(`  ✗ ${sourceFile}: text extracted but produced 0 chunks. Skipped.`);
    return { skipped: true, reason: 'no_chunks' };
  }

  // Re-embedding an unchanged document is pure quota waste, and the free tier
  // is the binding constraint on every run. Cheap to check, and it makes an
  // interrupted ingest resumable: re-run and it picks up where it stopped.
  if (
    !force &&
    existing &&
    existing.chunkCount === chunks.length &&
    existing.pageCount === totalPages
  ) {
    console.log(
      `  = ${sourceFile}\n` +
        `    unchanged since last ingest (${chunks.length} chunks / ${totalPages} pages). Skipped.`
    );
    return { skipped: true, reason: 'unchanged', docTitle, pages: totalPages, chunks: chunks.length };
  }

  const withClause = chunks.filter((c) => c.clause).length;
  const chars = chunks.reduce((s, c) => s + c.content.length, 0);
  console.log(
    `  → ${sourceFile}\n` +
      `    title    ${docTitle}\n` +
      `    pages    ${totalPages} (${totalChars} chars, ${sparsePages} sparse)\n` +
      `    chunks   ${chunks.length} (${withClause} with a clause number, avg ${Math.round(chars / chunks.length)} chars)`
  );

  // Embed in batches, attaching the vector to its chunk as we go.
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    if (pacer) await pacer.reserve(batch.length);
    const vectors = await embedDocuments(
      batch.map((c) => ({ text: toEmbeddableText(c), title: docTitle }))
    );
    batch.forEach((c, j) => {
      c.embedding = vectors[j];
    });
    process.stdout.write(
      `    embedded ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}` +
        `${pacer ? `  (quota pacing, ${Math.round(pacer.waited / 1000)}s waited)` : ''}\r`
    );
  }
  process.stdout.write('    embedded all chunks                    \n');

  await replaceDocumentChunks(
    {
      docId,
      docTitle,
      sourceFile,
      pageCount: totalPages,
      isScanned,
    },
    chunks
  );

  return { skipped: false, docTitle, pages: totalPages, chunks: chunks.length };
}

/**
 * Decide whether it is safe to prune, as a pure function so it can be tested
 * without a database.
 *
 * The per-file loop in main() catches its own errors so one bad PDF does not
 * abort the run, which means execution always reaches the prune step. That is
 * exactly the trap: a 429 on the embedding quota was swallowed, the single new
 * document errored, and the prune then deleted all six previously-indexed
 * documents. The run ended with an empty corpus and a green-looking log line —
 * strictly worse than having done nothing, because the old corpus could no
 * longer answer anything.
 *
 * So the rule is about whether the replacement landed, not about whether the
 * folder is non-empty. Pruning is skipped whenever any selected document failed
 * to ingest. The stale documents are then still stale, and the next successful
 * `npm run ingest` removes them.
 */
export function shouldPrune({ results, selectedCount, keepStale }) {
  if (keepStale) return { prune: false, reason: 'keep-stale' };
  if (!selectedCount) return { prune: false, reason: 'empty-selection' };

  const failed = results.filter((r) => r.error || (r.skipped && r.reason === 'no_chunks'));
  if (failed.length) {
    return {
      prune: false,
      reason: 'ingest-failed',
      failed: failed.map((r) => r.file),
    };
  }

  const landed = results.filter((r) => !r.error && !r.skipped);
  if (!landed.length) return { prune: false, reason: 'nothing-landed' };

  return { prune: true, reason: null };
}

/**
 * Remove indexed documents that are no longer selected for ingest.
 *
 * Ingest is otherwise append-only, so deleting a PDF from the folder leaves its
 * chunks in pgvector and the assistant keeps citing a document that no longer
 * exists. A document that is present but newly added to PDF_EXCLUDE is treated
 * the same way, because "excluded" means "do not have this".
 *
 * Callers must have consulted shouldPrune() first.
 */
async function pruneStaleDocuments(selectedDocIds, { already }) {
  const stale = [...already.values()].filter((d) => !selectedDocIds.has(d.docId));
  if (!stale.length) return [];

  console.log(`\nPruning ${stale.length} document(s) no longer selected for ingest:`);
  const removed = [];
  for (const doc of stale) {
    const { removedChunks } = await deleteDocument(doc.docId);
    console.log(`  - ${doc.sourceFile}  (${doc.chunkCount} chunks, ${removedChunks} removed)`);
    removed.push({ docId: doc.docId, sourceFile: doc.sourceFile, removedChunks });
  }
  return removed;
}

async function main() {
  assertConfig();
  await migrate();

  // Unfiltered, so we can tell the user what was held back rather than
  // silently ingesting less than they dropped in the folder.
  const allPdfs = await listPdfs(config.corpus.pdfDir, []);
  const pdfs = await listPdfs();

  if (!pdfs.length) {
    console.log(`\n✗ No PDFs to ingest in ${config.corpus.pdfDir}`);
    if (allPdfs.length) {
      console.log(`  ${allPdfs.length} PDF(s) are present but all are excluded by PDF_EXCLUDE:`);
      allPdfs.forEach((f) => console.log(`    - ${path.basename(f)}`));
      console.log('  Adjust PDF_EXCLUDE in .env to include them.');
    } else {
      console.log('  Add BIS standard PDFs there, then run: npm run ingest\n');
    }
    await closePool();
    process.exitCode = 1;
    return;
  }

  const skippedByConfig = allPdfs.filter((f) => !pdfs.includes(f));
  if (skippedByConfig.length) {
    console.log(
      `\nExcluding ${skippedByConfig.length} file(s) via PDF_EXCLUDE: ` +
        skippedByConfig.map((f) => path.basename(f)).join(', ')
    );
  }

  console.log(`\nIngesting ${pdfs.length} PDF(s) from ${config.corpus.pdfDir}\n`);

  const force = process.argv.includes('--force');
  const keepStale = process.argv.includes('--keep-stale');
  const already = new Map(
    (await getCorpusStats()).documents.map((d) => [d.docId, d])
  );
  const pacer = new EmbedPacer();

  const results = [];
  for (const file of pdfs) {
    try {
      results.push({
        file: path.basename(file),
        ...(await ingestOne(file, {
          existing: already.get(docIdFromPath(file)),
          force,
          pacer,
        })),
      });
    } catch (err) {
      console.log(`  ✗ ${path.basename(file)}: ${err.message}`);
      results.push({ file: path.basename(file), error: err.message });
    }
  }

  // Prune only after the ingest loop, only for documents that were actually
  // selected, and only if nothing failed — a run that dies partway must leave the
  // existing corpus intact.
  const decision = shouldPrune({ results, selectedCount: pdfs.length, keepStale });
  let pruned = [];
  if (decision.prune) {
    pruned = await pruneStaleDocuments(new Set(pdfs.map(docIdFromPath)), { already });
  } else if (decision.reason === 'keep-stale') {
    console.log('\n(--keep-stale: leaving unselected document(s) indexed)');
  } else if (decision.reason === 'ingest-failed') {
    console.log(
      `\n(!) Skipping prune: ${decision.failed.length} selected document(s) failed to ingest ` +
        `(${decision.failed.join(', ')}).` +
        '\n    Documents deleted from the PDF folder are still indexed, so the assistant can' +
        '\n    keep answering. Re-run `npm run ingest` once the failure is fixed to prune them.'
    );
  } else if (decision.reason === 'empty-selection') {
    console.log('\n(!) Refusing to prune: no documents selected for ingest. Corpus left untouched.');
  }

  const stats = await getCorpusStats();
  if (pacer.waited > 1000) {
    console.log(`\n(Embed quota pacing: waited ${Math.round(pacer.waited / 1000)}s total to stay under the free-tier limit)`);
  }

  console.log('\n' + '='.repeat(66));
  console.log('INGEST SUMMARY');
  console.log('='.repeat(66));
  for (const r of results) {
    // A 429 carries a multi-line JSON body; collapse it so one failure does not
    // shred the summary table.
    const brief = r.error ? r.error.replace(/\s+/g, ' ').trim().slice(0, 46) : null;
    const status = brief
      ? `ERROR  ${brief}`
      : r.skipped
        ? `SKIP   ${r.reason}`
        : `OK     ${r.chunks} chunks / ${r.pages} pages`;
    console.log(`  ${r.file.padEnd(42)} ${status}`);
  }
  console.log('-'.repeat(66));
  for (const p of pruned) {
    console.log(`  ${p.sourceFile.padEnd(42)} PRUNED ${p.removedChunks} chunks`);
  }
  console.log(`  corpus: ${stats.docCount} document(s), ${stats.chunkCount} chunk(s) in pgvector`);
  console.log('='.repeat(66) + '\n');

  const failed = results.filter((r) => r.error || (r.skipped && r.reason === 'no_chunks'));
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('\n✗ Ingest failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
