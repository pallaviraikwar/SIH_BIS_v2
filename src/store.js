import { pool, query, toVectorLiteral } from './db.js';
import { config } from './config.js';

/**
 * Replace every chunk for a document in one transaction, so a re-ingest can
 * never leave a document half-updated if embedding fails halfway.
 */
export async function replaceDocumentChunks(docMeta, chunks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('delete from bis_chunks where doc_id = $1', [docMeta.docId]);

    if (chunks.length) {
      // One multi-row insert. 8 bound parameters per row: the 8th is cast to
      // vector, the 5th (clause) is nullable.
      const COLS_PER_ROW = 8;
      const values = [];
      const params = [];

      chunks.forEach((c, i) => {
        const b = i * COLS_PER_ROW;
        values.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}::vector)`
        );
        params.push(
          c.docId,
          c.docTitle,
          c.pageFrom,
          c.pageTo,
          c.clause ?? null,
          c.chunkIndex,
          c.content,
          toVectorLiteral(c.embedding)
        );
      });

      await client.query(
        `insert into bis_chunks
           (doc_id, doc_title, page_from, page_to, clause, chunk_index, content, embedding)
         values ${values.join(', ')}`,
        params
      );
    }

    await client.query(
      `insert into bis_documents (doc_id, doc_title, source_file, page_count, chunk_count, is_scanned)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (doc_id) do update
         set doc_title = excluded.doc_title,
             source_file = excluded.source_file,
             page_count = excluded.page_count,
             chunk_count = excluded.chunk_count,
             is_scanned = excluded.is_scanned,
             ingested_at = now()`,
      [
        docMeta.docId,
        docMeta.docTitle,
        docMeta.sourceFile,
        docMeta.pageCount,
        chunks.length,
        docMeta.isScanned,
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Incremental ingest.
 *
 * The free tier allows 1000 embedContent requests per day. A 929-page
 * standard produces ~3,400 chunks, so ingest cannot always finish in one
 * session, and previously that meant throwing away every embedding it had
 * already paid for the moment a quota error appeared. These functions let a
 * run commit each batch as it lands and pick up where it stopped.
 * ------------------------------------------------------------------ */

/**
 * Open a document for incremental writing.
 *
 * Deletes any previous chunks and registers the document as 'pending' with the
 * chunk count we expect. `contentHash` guards the resume: if the stored hash
 * differs, the PDF changed and the old chunks are meaningless, so they are
 * dropped rather than blended with new ones.
 *
 * Returns the set of chunk indexes already embedded under the same hash, so the
 * caller can skip them. Empty on a fresh ingest.
 */
export async function beginDocument(docMeta, { expectedChunks, contentHash }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `select embedded_count, content_hash, status from bis_documents where doc_id = $1 for update`,
      [docMeta.docId]
    );

    const prior = rows[0];
    const resumable =
      prior && prior.status === 'pending' && prior.content_hash && prior.content_hash === contentHash;

    if (resumable) {
      // Keep what we already paid for; just re-stamp the metadata.
      await client.query(
        `update bis_documents
            set doc_title = $2, source_file = $3, page_count = $4, chunk_count = $5, is_scanned = $6
          where doc_id = $1`,
        [
          docMeta.docId,
          docMeta.docTitle,
          docMeta.sourceFile,
          docMeta.pageCount,
          expectedChunks,
          docMeta.isScanned,
        ]
      );
    } else {
      await client.query('delete from bis_chunks where doc_id = $1', [docMeta.docId]);
      await client.query(
        `insert into bis_documents
           (doc_id, doc_title, source_file, page_count, chunk_count, is_scanned, status, embedded_count, content_hash)
         values ($1, $2, $3, $4, $5, $6, 'pending', 0, $7)
         on conflict (doc_id) do update
           set doc_title = excluded.doc_title,
               source_file = excluded.source_file,
               page_count = excluded.page_count,
               chunk_count = excluded.chunk_count,
               is_scanned = excluded.is_scanned,
               status = 'pending',
               embedded_count = 0,
               content_hash = excluded.content_hash,
               ingested_at = now()`,
        [
          docMeta.docId,
          docMeta.docTitle,
          docMeta.sourceFile,
          docMeta.pageCount,
          expectedChunks,
          docMeta.isScanned,
          contentHash,
        ]
      );
    }

    const done = new Set();
    if (resumable && prior.embedded_count > 0) {
      const { rows: idx } = await client.query(
        'select chunk_index from bis_chunks where doc_id = $1',
        [docMeta.docId]
      );
      idx.forEach((r) => done.add(r.chunk_index));
    }

    await client.query('COMMIT');
    return { resumable, embeddedIndexes: done };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Commit one batch of embedded chunks and advance the progress counter.
 *
 * The insert and the counter update share a transaction, so embedded_count can
 * never claim more chunks than are actually stored.
 */
export async function appendChunks(docId, chunks) {
  if (!chunks.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const COLS_PER_ROW = 8;
    const values = [];
    const params = [];
    chunks.forEach((c, i) => {
      const b = i * COLS_PER_ROW;
      values.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}::vector)`
      );
      params.push(
        c.docId,
        c.docTitle,
        c.pageFrom,
        c.pageTo,
        c.clause ?? null,
        c.chunkIndex,
        c.content,
        toVectorLiteral(c.embedding)
      );
    });

    await client.query(
      `insert into bis_chunks
         (doc_id, doc_title, page_from, page_to, clause, chunk_index, content, embedding)
       values ${values.join(', ')}
       on conflict (doc_id, chunk_index) do update
         set doc_title = excluded.doc_title,
             page_from = excluded.page_from,
             page_to = excluded.page_to,
             clause = excluded.clause,
             content = excluded.content,
             embedding = excluded.embedding`,
      params
    );

    await client.query(
      'update bis_documents set embedded_count = embedded_count + $2 where doc_id = $1',
      [docId, chunks.length]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a document searchable.
 *
 * Refuses to promote an incomplete document. Silently flipping status to 'ready'
 * with chunks missing would produce confident answers citing a document whose
 * later sections were never indexed — a silent correctness bug far worse than an
 * explicit failure.
 */
export async function finalizeDocument(docId) {
  const { rows } = await query(
    `update bis_documents set status = 'ready', ingested_at = now()
      where doc_id = $1 and embedded_count >= chunk_count
      returning doc_id, chunk_count, embedded_count`,
    [docId]
  );

  if (!rows.length) {
    const { rows: cur } = await query(
      'select chunk_count, embedded_count from bis_documents where doc_id = $1',
      [docId]
    );
    const c = cur[0] ?? { chunk_count: 0, embedded_count: 0 };
    throw new Error(
      `Refusing to mark ${docId} ready: ${c.embedded_count}/${c.chunk_count} chunks embedded.`
    );
  }
  return rows[0];
}

/** Remove half-ingested documents left behind by an interrupted run. */
export async function discardPendingDocuments() {
  const { rows } = await query(`delete from bis_documents where status = 'pending' returning doc_id`);
  for (const r of rows) {
    await query('delete from bis_chunks where doc_id = $1', [r.doc_id]);
  }
  return rows.map((r) => r.doc_id);
}

/**
 * Documents that are part-way through embedding, with their progress.
 *
 * Used to clean up after a PDF that was removed from the folder mid-ingest: the
 * partial chunks are not searchable, so dropping them costs nothing, but leaving
 * them behind makes `npm run ingest` report a phantom document forever.
 */
export async function listPendingDocuments() {
  const { rows } = await query(
    `select doc_id, source_file, chunk_count, embedded_count
       from bis_documents where status = 'pending' order by source_file`
  );
  return rows.map((r) => ({
    docId: r.doc_id,
    sourceFile: r.source_file,
    chunkCount: r.chunk_count,
    embeddedCount: r.embedded_count,
  }));
}

/**
 * Shape a chunk row into the object the rest of the app passes around.
 *
 * `similarity` is always the true cosine similarity, never a keyword score and
 * never a fused rank. That is deliberate: the reply bands (answer / soft /
 * bridge / miss) are decided on cosine similarity, so anything that changes what a
 * user is shown must be able to compare against the calibrated threshold. A fused
 * score is an ordering device and is not on that scale.
 */
function mapChunk(r) {
  return {
    id: r.id,
    docId: r.doc_id,
    docTitle: r.doc_title,
    pageFrom: r.page_from,
    pageTo: r.page_to,
    clause: r.clause,
    chunkIndex: r.chunk_index,
    content: r.content,
    similarity: Number(r.similarity),
  };
}

const CHUNK_COLUMNS = `c.id, c.doc_id, c.doc_title, c.page_from, c.page_to,
       c.clause, c.chunk_index, c.content`;

/**
 * Cosine nearest-neighbour search, with a floor rather than a hard cutoff.
 *
 * This used to take `threshold` and apply it in SQL, which meant every result
 * below the bar was destroyed inside the database before a reply could be
 * composed. That is what made refusals static: with the near misses already gone,
 * the only thing left to say is "I could not find that", because there is
 * genuinely no evidence left to say anything else with.
 *
 * So the caller passes a `floor` (below it, nothing is worth showing) and gets
 * the whole ranked band back. Bounding on the weak end is still worth doing in
 * SQL — a large corpus would otherwise ship every chunk — but the bar that decides
 * whether to *answer* is applied afterwards, in rag.js.
 */
export async function searchChunks({ embedding, topK = 5, floor, docId = null }) {
  // No default on the parameter itself. A default here silently becomes the real
  // threshold for any caller that forgets to pass one, and config.js should be
  // the only place this number is decided.
  const min = floor ?? config.retrieval.bridgeFloor;
  const fetchCount = Math.max(topK * 4, topK + 5);

  const { rows } = await query(
    `select
        ${CHUNK_COLUMNS},
        1 - (c.embedding <=> $1::vector) as similarity
    from bis_chunks c
    join bis_documents d on d.doc_id = c.doc_id and d.status = 'ready'
    where 1 - (c.embedding <=> $1::vector) >= $2
      and ($3::text is null or c.doc_id = $3::text)
    order by c.embedding <=> $1::vector
    limit $4`,
    [toVectorLiteral(embedding), min, docId, fetchCount]
  );

  return rows.slice(0, topK).map(mapChunk);
}

/**
 * Keyword search, for the part of the question space embeddings cannot reach:
 * standard identifiers.
 *
 * A bare "IS 456" embeds at 0.546 — below the answer bar — because a number
 * carries almost no meaning on its own and an embedding has no way to treat "456"
 * as an identifier rather than a quantity. `search_tsv` matches it exactly, and the
 * two results are fused.
 *
 * There is no fuzzy/trigram arm, and that is a measured decision rather than an
 * omission. `word_similarity` was tried and removed: on 765-character chunks it
 * returns the same score for everything. "brks" scored an identical 0.600 against
 * "Tolerances", "thermocouple" and "Acoustical materials", and "cemnt" returned
 * "solvent cement", "polyester resin" and "PVC fittings" at 0.667 — eight rows,
 * all wrong, all ranked as matches. A retriever that returns wrong text confidently
 * is worse than one that returns nothing, because the fusion then promotes the
 * wrong row. Whole-word matching abstains on misspellings, which is the correct
 * behaviour: those queries fall to the bridge band and get an honest near-miss.
 *
 * The cosine similarity is still computed here, from the vector the caller already
 * holds, so a chunk found only by the keyword arm arrives with a real score and can
 * be banded like any other.
 */
export async function searchByKeyword({ text, embedding, topK, docId = null }) {
  const limit = topK ?? config.retrieval.keywordTopK;
  const q = String(text ?? '').trim();
  if (!q) return [];

  const { rows } = await query(
    `select
        ${CHUNK_COLUMNS},
        1 - (c.embedding <=> $3::vector) as similarity,
        ts_rank_cd(c.search_tsv, websearch_to_tsquery('simple', $1)) as text_rank
    from bis_chunks c
    join bis_documents d on d.doc_id = c.doc_id and d.status = 'ready'
    where ($2::text is null or c.doc_id = $2::text)
      and c.search_tsv @@ websearch_to_tsquery('simple', $1)
    order by ts_rank_cd(c.search_tsv, websearch_to_tsquery('simple', $1)) desc,
             c.embedding <=> $3::vector
    limit $4`,
    [q, docId, toVectorLiteral(embedding), limit]
  );

  return rows.map((r) => ({
    ...mapChunk(r),
    textRank: Number(r.text_rank),
  }));
}

/**
 * The standard identifier a query is asking about, if it names one.
 *
 * "IS 456", "is 456:2000" and "IS 10262 : 2019" all name a specific standard, and
 * finding the clause that actually prints that identifier is a lookup, not a
 * similarity judgement. The identifier is normalised to digits-and-year so the
 * spacing variants in the corpus ("IS1 3360", "IS 3583:1988") still compare equal.
 *
 * Returns null for anything that is not an identifier, which is what keeps the band
 * promotion narrow: a common-word tsvector hit must never be able to lift a reply
 * into the answer band on its own.
 */
export function parseIsIdentifier(query) {
  const m = String(query ?? '').match(/\bIS\s*:?\s*(\d{2,6})\s*(?::\s*(\d{4}))?/i);
  if (!m) return null;
  return { code: m[1], year: m[2] ?? null };
}

/**
 * Whether a passage actually prints the identifier the query named.
 *
 * A containment test on the digit sequence, not on the formatted string, because
 * the corpus is inconsistent about spacing and the year separator: "IS 456",
 * "IS 456:2000" and "IS 456 : 2000" all appear, and one malformed extraction should
 * not decide the band.
 */
export function passageHasIdentifier(passage, identifier) {
  if (!identifier) return false;
  const text = String(passage?.content ?? '');
  if (!new RegExp(`\\b${identifier.code}\\b`).test(text)) return false;
  if (identifier.year && !text.includes(identifier.year)) return false;
  return true;
}

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

/**
 * The combined retrieval used by the answer path.
 *
 * Falls back to the vector arm alone when keyword search is disabled or fails.
 * A missing FTS index is a deployment state, not a reason to fail the request:
 * the vector path is the one that was working before hybrid search existed.
 */
export async function retrieveHybrid({ embedding, text, topK, docId = null }) {
  const vectorRows = await searchChunks({
    embedding,
    topK,
    floor: config.retrieval.bridgeFloor,
    docId,
  });

  if (!config.retrieval.hybridSearch || !text) return vectorRows;

  try {
    const keywordRows = await searchByKeyword({ text, embedding, docId });
    return fuseRRF(vectorRows, keywordRows, { limit: topK });
  } catch (err) {
    console.warn(
      `[store] keyword retrieval unavailable (${err.message}); using vectors only. ` +
        'Re-run the schema migration to create the FTS indexes.'
    );
    return vectorRows;
  }
}

/**
 * Real subject titles from the indexed corpus, for use as suggestions.
 *
 * A dead-end reply that names topics the corpus genuinely contains is the
 * difference between a dead end and a redirect. These are read out of the chunk
 * text rather than kept in a hand-written list, for one reason: a hardcoded list
 * drifts. This project already had that failure — the sidebar offered
 * certification, laboratories and hallmarking, none of which appear anywhere in
 * SP 21, and all three were guaranteed refusals.
 *
 * The pattern below is the bibliographic form used throughout SP 21:
 *
 *   IS 3583:1988 Specification for clay paving bricks
 *
 * Titles are pulled straight out of the text, so a document that is added,
 * removed or re-ingested changes the suggestions with no code edit. 759 titles
 * parse cleanly on the current corpus.
 *
 * Truncation is a real hazard here: the character cap can cut a title mid-word
 * ("Low density polyethylene pipes for potable water supp"), and a suggestion
 * ending in a fragment reads as broken. `tidyTitle` trims back to the last whole
 * word. Titles that are too short to survive that are dropped rather than shown
 * as stubs.
 */
const IS_TITLE_PATTERN =
  'IS\\s+([0-9]{2,6})\\s*:\\s*([0-9]{4})\\s+([A-Z][A-Za-z0-9 ,()\\-/&]{10,100})([A-Za-z0-9 ,()\\-/&]?)';

export function tidyTitle(raw, truncated = false) {
  let t = String(raw ?? '')
    .replace(/IS\s+[0-9]{2,6}\s*:\s*[0-9]{4}\s+/i, '')
    .replace(/\s*[-–—:;,]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Drop revision notes. SP 21 writes these inline — "...enamels (second
  // revision)" — and they are index metadata, not part of what the standard is
  // about, so they make poor suggestions.
  //
  // Stripped anywhere in the title, not just at the end: when the 100-character
  // cap lands mid-title the note is left stranded in the middle, e.g. "...
  // supplies (first revision) Part I General".
  //
  // Whether the strip succeeded matters below, so compare rather than assign
  // blind.
  const withoutRevisionNote = t
    .replace(/\s*\(\s*(?:first|second|third|fourth|fifth)?\s*revision\s*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const hadRevisionNote = withoutRevisionNote !== t;
  t = withoutRevisionNote;

  // Only repair a cut, and only when the pattern really did cut one.
  //
  // The character cap in IS_TITLE_PATTERN is unavoidable: titles are followed by
  // descriptive prose with no delimiter, so something has to stop the match. But
  // repairing unconditionally mangles every naturally short title — an earlier
  // version turned "Specification for clay paving bricks" into "Specification for
  // clay paving" because it trimmed at the last space regardless. `truncated` is
  // the caller's signal that the overflow group matched, i.e. the cap did the cut.
  if (!truncated) return t.length >= 12 ? t : '';

  // Cut back to a whole word, but only if something is still actually left
  // dangling. Two separate bugs lived in here:
  //
  //  - Cutting inside the repair loop made each pass trim an already-aligned
  //    string again, one word per pass, until "Low density polyethylene pipes for
  //    potable water supp" became "Low density polyethylene pipes".
  //  - Cutting unconditionally after the revision-note strip cost another word,
  //    because the strip had just left the string cleanly word-aligned: "...paints
  //    and enamels (second revision)" lost " and enamels".
  //
  // A complete trailing parenthetical is a whole token, so removing it leaves
  // nothing to repair. Only cut when no strip realigned things.
  if (!hadRevisionNote) {
    const lastSpace = t.lastIndexOf(' ');
    if (lastSpace > 24) t = t.slice(0, lastSpace);
  }

  // Then repair to a fixpoint: an unbalanced bracket and a dangling function word
  // can each expose the other, and a cap that severed a trailing "(second" is
  // repaired here. Bounded so a pathological input cannot spin.
  for (let pass = 0; pass < 4; pass++) {
    const before = t;

    // A trailing parenthetical still open at the end is a severed note.
    const open = t.indexOf('(');
    if (open !== -1 && t.indexOf(')', open) === -1) t = t.slice(0, open);

    // A dangling function word is what a mid-phrase cut usually leaves.
    t = t.replace(/\s+(for|of|and|or|the|to|in|with|on|at|by|from)$/i, '');

    t = t.replace(/\s*[-–—:;,]\s*$/, '').trim();
    if (t === before) break;
  }

  return t.length >= 12 ? t : '';
}

export async function corpusTopics({ limit = config.retrieval.suggestionCount } = {}) {
  // Over-fetch so deduplication and filtering still leave `limit` usable titles.
  const { rows } = await query(
    `select distinct on (m[1]) m[1] as code, m[2] as year, m[3] as raw_title,
            m[4] <> '' as truncated,
            min(c.chunk_index) as first_seen
       from bis_chunks c,
            lateral regexp_matches(c.content, $1, 'g') as m
      group by m[1], m[2], m[3], m[4]
      order by m[1], min(c.chunk_index)`,
    [IS_TITLE_PATTERN]
  );

  const seen = new Set();
  const topics = [];
  for (const r of rows) {
    const title = tidyTitle(r.raw_title, r.truncated);
    if (!title) continue;
    const key = `${r.code}:${r.year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push({ code: r.code, year: r.year, title, isCode: `IS ${r.code}:${r.year}` });
    if (topics.length >= limit * 3) break;
  }
  return topics.slice(0, limit);
}

/**
 * A stable-per-query, non-repeating slice of the corpus topics.
 *
 * The rotation matters: always suggesting the same six titles means a user who
 * rejects all six has learned there is nothing else to try. Seeding the shuffle
 * from the query means the same question always yields the same suggestions —
 * stable under refresh, which a random shuffle would not be — while different
 * questions explore different parts of the corpus.
 */
export function rotateTopics(topics, seed = '') {
  if (topics.length <= 1) return topics;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const start = Math.abs(h) % topics.length;
  return [...topics.slice(start), ...topics.slice(0, start)];
}

export async function getCorpusStats() {
  const { rows: [totals] } = await query(
    `select
        (select count(*) from bis_chunks c
           join bis_documents d on d.doc_id = c.doc_id and d.status = 'ready') as chunk_count,
        (select count(*) from bis_documents where status = 'ready') as doc_count,
        (select count(*) from bis_documents where status = 'pending') as pending_count`
  );
  const { rows } = await query(
    `select doc_id, doc_title, source_file, page_count, chunk_count, is_scanned, ingested_at
     from bis_documents
     where status = 'ready'
     order by doc_title`
  );
  return {
    chunkCount: Number(totals.chunk_count),
    docCount: Number(totals.doc_count),
    pendingCount: Number(totals.pending_count),
    documents: rows.map((r) => ({
      docId: r.doc_id,
      docTitle: r.doc_title,
      sourceFile: r.source_file,
      pageCount: r.page_count,
      chunkCount: r.chunk_count,
      isScanned: r.is_scanned,
      ingestedAt: r.ingested_at,
    })),
  };
}

/**
 * The on-disk filename for one document, resolved by its database id.
 *
 * This exists so the PDF route never has to accept a path from the request. The
 * filename lives in `bis_documents.source_file` and the URL carries only the
 * docId, so the set of files this server can be made to hand out is exactly the
 * set that was ingested. Taking a filename from the query string would put
 * `../` in reach of anyone with a browser.
 *
 * Scoped to `status = 'ready'` for the same reason the corpus stats are: a
 * half-ingested or discarded document is not something a citation should be able
 * to surface, and its file may not even be complete on disk yet.
 */
export async function getDocumentSource(docId) {
  const { rows } = await query(
    `select doc_id, doc_title, source_file, page_count, is_scanned
     from bis_documents
     where doc_id = $1 and status = 'ready'`,
    [docId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    docId: r.doc_id,
    docTitle: r.doc_title,
    sourceFile: r.source_file,
    pageCount: Number(r.page_count),
    isScanned: r.is_scanned,
  };
}

/**
 * Titles of everything indexed, for scope-aware answers.
 *
 * Used to tell a user what the corpus actually covers, so a refusal is
 * informative instead of just being "no".
 */
export async function listDocumentTitles() {
  const { rows } = await query(
    `select doc_title from bis_documents where status = 'ready' order by doc_title`
  );
  return rows.map((r) => r.doc_title);
}

/**
 * Drop a document and all of its chunks.
 *
 * Needed because ingest only ever adds: a PDF deleted from the folder (or newly
 * added to PDF_EXCLUDE) otherwise stays in the vector store forever and keeps
 * getting cited, so the assistant quotes documents the user has removed.
 */
export async function deleteDocument(docId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: chunkCount } = await client.query(
      'delete from bis_chunks where doc_id = $1',
      [docId]
    );
    const { rowCount: docCount } = await client.query(
      'delete from bis_documents where doc_id = $1',
      [docId]
    );
    await client.query('COMMIT');
    return { removedDocs: docCount, removedChunks: chunkCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
