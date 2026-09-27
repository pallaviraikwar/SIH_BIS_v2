/**
 * Ranking.
 *
 * How the vector and keyword arms are combined, with no database involved: RRF
 * depends only on the order the two retrievers returned rows in, not on their
 * scores, so it is worth keeping somewhere it can be read and tested without a
 * Postgres connection. It used to live in store.js, which made a pure function
 * look like part of the storage layer and put the whole module's import graph
 * (and pool) in the way of testing it.
 */
import { config } from './config.js';

/**
 * Reciprocal-rank fusion of the vector and keyword rankings.
 *
 * RRF rather than a weighted sum of scores because cosine similarity (0..1) and
 * ts_rank/word_similarity are not on a comparable scale, and any numeric blend
 * would need re-tuning whenever either retriever changes. RRF depends only on rank
 * order, which is far more stable: `1 / (k + rank)` summed over the rankers that
 * returned a given chunk.
 *
 * A chunk found by both arms outranks one found by either, which is the behaviour
 * that matters here — a chunk whose text literally contains the words the user
 * typed *and* which is semantically close is the one worth answering from.
 */
export function fuseRRF(vectorRows, keywordRows, { rrfK = config.retrieval.rrfK, limit } = {}) {
  const scores = new Map();
  const merged = new Map();

  const contribute = (rows, rankKey) => {
    rows.forEach((row, i) => {
      const rank = i + 1;
      const prior = scores.get(row.id) ?? { fused: 0, vectorRank: null, keywordRank: null };
      prior.fused += 1 / (rrfK + rank);
      if (rankKey === 'vector') prior.vectorRank = rank;
      else prior.keywordRank = rank;
      scores.set(row.id, prior);
      // First writer wins, and the vector arm is passed first, so the row keeps
      // the vector arm's fields as the base and the keyword arm only adds scores.
      if (!merged.has(row.id)) merged.set(row.id, { ...row });
    });
  };

  if (vectorRows?.length) contribute(vectorRows, 'vector');
  if (keywordRows?.length) contribute(keywordRows, 'keyword');

  return [...merged.values()]
    .map((row) => ({ ...row, ...scores.get(row.id) }))
    .sort((a, b) => {
      if (b.fused !== a.fused) return b.fused - a.fused;
      // Deterministic tie-break. Without it two equally-scored chunks could swap
      // places between identical requests, and the Sources list would reorder
      // itself under the user on refresh.
      return b.similarity - a.similarity;
    })
    .slice(0, limit ?? vectorRows?.length ?? keywordRows?.length ?? 0);
}
