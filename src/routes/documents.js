import express from 'express';
import { getCorpusStats } from '../store.js';

export const documentsRouter = express.Router();

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
