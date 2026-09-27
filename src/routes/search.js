import express from 'express';
import { searchOnly } from '../rag.js';
import { config } from '../config.js';

export const searchRouter = express.Router();

/**
 * Retrieval without generation.
 *
 * Shows the cosine score for every candidate, which is how the threshold in
 * .env gets tuned, and reports the band the answer path would have chosen.
 *
 * The frontend does use this: the sidebar's "Search passages" box calls it, so
 * a defect here is a dead search box rather than a broken debug tool. That
 * comment used to say the opposite, which is part of why `searchOnly` went
 * untested and a typo in it shipped — see test/search.test.js.
 */
searchRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'Provide ?q=<query>' });

  const topK = Number.isFinite(Number(req.query.k)) ? Math.min(Number(req.query.k), 25) : config.retrieval.topK;
  const threshold = Number.isFinite(Number(req.query.threshold))
    ? Number(req.query.threshold)
    : config.retrieval.threshold;

  try {
    // `lang` is optional and defaults to auto-detection from the query text, so
    // /api/search and /api/chat now decide what a query means the same way. It
    // previously accepted no language at all, while `searchOnly` hardcoded 'en' —
    // which meant a Devanagari query here was silently mistranslated into nothing
    // and the endpoint reported a band for a search the answer path would never
    // have run. Pass ?lang=hi to override, exactly as with /api/chat.
    const { query, originalQuery, lang, translated, passages, topSimilarity, band } =
      await searchOnly(q, { topK, threshold, lang: req.query.lang });
    return res.json({
      query,
      originalQuery,
      lang,
      translated,
      topK,
      threshold,
      // Which band the answer path would have chosen, and the score it decided on.
      // Previously this endpoint returned only the filtered list, so the near
      // misses that explain a refusal were invisible and the threshold looked
      // arbitrary when tuning it.
      band,
      topSimilarity,
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
