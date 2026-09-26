import express from 'express';
import { searchOnly } from '../rag.js';
import { config } from '../config.js';

export const searchRouter = express.Router();

/**
 * Retrieval without generation.
 *
 * Exists so the vector search can be demonstrated and debugged on its own —
 * it shows the cosine score for every candidate, which is how the threshold in
 * .env gets tuned. The chatbot frontend does not use this.
 */
searchRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'Provide ?q=<query>' });

  const topK = Number.isFinite(Number(req.query.k)) ? Math.min(Number(req.query.k), 25) : config.retrieval.topK;
  const threshold = Number.isFinite(Number(req.query.threshold))
    ? Number(req.query.threshold)
    : config.retrieval.threshold;

  try {
    const { query, passages } = await searchOnly(q, { topK, threshold });
    return res.json({
      query,
      topK,
      threshold,
      count: passages.length,
      results: passages.map((p, i) => ({
        rank: i + 1,
        docTitle: p.docTitle,
        clause: p.clause,
        pages: p.pageFrom === p.pageTo ? [p.pageFrom] : [p.pageFrom, p.pageTo],
        similarity: Number(p.similarity.toFixed(4)),
        preview: p.content.slice(0, 300),
      })),
    });
  } catch (err) {
    console.error('[search] failed:', err);
    return res.status(500).json({ error: err.message });
  }
});
