import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getCorpusStats, corpusTopics, getDocumentSource } from '../store.js';
import { config } from '../config.js';

export const documentsRouter = express.Router();

/**
 * Where a cited page actually lives in the corpus directory.
 *
 * The filename comes from `bis_documents.source_file` via the docId, never from
 * the request, so a caller cannot name a file. What is left to defend against is
 * a `source_file` that itself contains a traversal sequence — the column is
 * written by the ingest script from a user-supplied filename, so it is trusted
 * input only in the sense that this process wrote it. `path.resolve` collapses
 * `..` and the prefix check then refuses anything that landed outside
 * `config.corpus.pdfDir`.
 *
 * Exported so the guard is testable without going through HTTP.
 */
export function resolvePdfPath(docId, sourceFile) {
  if (typeof sourceFile !== 'string' || !sourceFile.trim()) return null;

  // A NUL byte truncates the path in some syscalls, so it is rejected before any
  // filesystem call rather than being sanitised.
  if (sourceFile.includes('\0')) return null;

  // The ingest script stores a basename, so an absolute `source_file` means
  // something is already wrong. Refusing it outright means the prefix check below
  // is a second line of defence rather than the only one.
  if (path.isAbsolute(sourceFile)) return null;

  const base = path.resolve(config.corpus.pdfDir);
  const full = path.resolve(base, sourceFile);
  if (full !== base && !full.startsWith(base + path.sep)) return null;

  return full;
}

/**
 * Serves the source PDF for a cited page, so a citation can be checked.
 *
 * The point of the citation is that it can be verified, and a page reference with
 * no way to reach the page is only marginally better than a page reference with
 * no way to reach the document at all. The frontend links here with `#page=N`,
 * which every mainstream PDF viewer understands, so the browser renders the real
 * page rather than this project reimplementing a PDF renderer.
 *
 * Range requests are handled by `res.sendFile`, so the viewer can seek inside a
 * 929-page document without downloading all of it first.
 *
 * Note for deployment: this makes the source document downloadable by anyone who
 * can reach the server. The corpus is excluded from the repository because the
 * BIS standard PDFs are not ours to redistribute, so on a public host this route
 * is effectively a publication of the document. That is the correct behaviour for
 * a local or internal deployment, where being able to verify a citation is the
 * whole point, but it should be a deliberate decision rather than a surprise.
 */
documentsRouter.get('/documents/:docId/pdf', async (req, res) => {
  const { docId } = req.params;

  let doc;
  try {
    doc = await getDocumentSource(docId);
  } catch (err) {
    console.error('[documents] pdf lookup failed:', err);
    return res.status(503).json({ error: 'corpus unavailable' });
  }

  if (!doc) return res.status(404).json({ error: 'no such document' });

  const full = resolvePdfPath(doc.docId, doc.sourceFile);
  if (!full) {
    console.error(`[documents] refusing to serve ${doc.sourceFile} for ${docId}: outside ${config.corpus.pdfDir}`);
    return res.status(404).json({ error: 'source unavailable' });
  }

  // A scanned document has no text layer, so the citation cannot be checked
  // against it any better than by looking. Serving it would imply a
  // verifiability the ingest step already decided we do not have.
  if (doc.isScanned) {
    return res.status(404).json({ error: 'document has no text layer' });
  }

  // Synchronous check so a citation to a document whose file was moved or deleted
  // renders as a quiet 404 rather than an unhandled rejection inside sendFile.
  if (!fs.existsSync(full)) {
    console.warn(`[documents] indexed document ${docId} has no file at ${full}`);
    return res.status(404).json({ error: 'source file missing' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  // `inline` so the browser's viewer opens it rather than downloading it, which
  // is what a user clicking "verify this citation" expects.
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.docTitle)}.pdf"`);
  return res.sendFile(full);
});

/** Whether a citation to this document can be opened, for render-time decisions. */
documentsRouter.get('/documents/citable', async (_req, res) => {
  try {
    const { documents } = await getCorpusStats();
    return res.json({
      // Only documents that can actually be served. Rendering a link for a
      // scanned or missing file would produce a dead citation, which is worse
      // than a plain page reference because it looks verified and is not.
      docIds: documents.filter((d) => !d.isScanned).map((d) => d.docId),
    });
  } catch (err) {
    console.error('[documents] citable failed:', err);
    return res.json({ docIds: [] });
  }
});

/**
 * Lists what is actually in the vector store.
 *
 * The frontend used to hardcode a handful of Indian Standard codes and present
 * them as a searchable directory. That is worse than having no directory: a code
 * shown there looks authoritative but is not in the corpus, so clicking it
 * produces a refusal and the UI looks broken. This endpoint lets the panel show
 * the real corpus instead, which also makes the limits of the system visible —
 * a user can see there is no product standard in here before asking about one.
 */
documentsRouter.get('/documents', async (_req, res) => {
  try {
    const { docCount, chunkCount, documents } = await getCorpusStats();
    return res.json({
      count: docCount,
      chunkCount,
      documents: documents.map((d) => ({
        docTitle: d.docTitle,
        sourceFile: d.sourceFile,
        pageCount: d.pageCount,
        chunkCount: d.chunkCount,
        isScanned: d.isScanned,
      })),
    });
  } catch (err) {
    console.error('[documents] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Real standard titles from the indexed text, for the sidebar.
 *
 * Replaces a hardcoded list of four Indian Standard codes that were all absent
 * from the corpus. Every one of them was a dead end: a code rendered as a
 * clickable link looks authoritative, so a refusal behind it reads as a broken
 * application rather than as "that standard is not loaded". Deriving the list from
 * `bis_chunks` means the sidebar can only ever offer something the assistant can
 * actually answer, and it updates itself when the corpus does.
 */
documentsRouter.get('/topics', async (_req, res) => {
  try {
    const topics = await corpusTopics({ limit: config.retrieval.suggestionCount * 3 });
    return res.json({ count: topics.length, topics });
  } catch (err) {
    console.error('[topics] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});
