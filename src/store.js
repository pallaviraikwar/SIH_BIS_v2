import { pool, query, toVectorLiteral } from './db.js';
import { config } from './config.js';
import { fuseRRF } from './rank.js';
import { tidyTitle } from './text.js';

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
 * Real topics from the indexed corpus, for use as suggestions.
 *
 * A dead-end reply that names topics the corpus genuinely contains is the
 * difference between a dead end and a redirect. These are read out of the index
 * rather than kept in a hand-written list, for one reason: a hardcoded list
 * drifts. This project already had that failure — the sidebar offered
 * certification, laboratories and hallmarking, none of which appear anywhere in
 * SP 21, and all three were guaranteed refusals.
 *
 * Topics are clauses, and they are balanced across documents. Both halves of
 * that matter, and both were learned the hard way.
 *
 * The previous definition scraped standard designations out of the text:
 *
 *   IS 3583:1988 Specification for clay paving bricks
 *
 * That is the bibliographic form used throughout SP 21, and SP 21 is a
 * catalogue of standards, so it is the only document in the corpus that contains
 * any. On the current corpus that pattern yields 519 topics, of which 517 come
 * from SP 21: BIS CA contributes 2, and the Hallmarking Regulations, the
 * Guidelines of Labelling and the BIS Act contribute nothing at all. The drawer
 * showed 18 chips and every one of them was SP 21. Four of five documents were
 * invisible, which is the opposite of what a browser is for.
 *
 * So a topic is now a clause, which every document has: 819 distinct clause
 * numbers, 99%+ of chunks in all five documents. The clause number is the label
 * rather than a snippet of the text because two documents extract their
 * Devanagari badly — BIS CA and the Hallmarking Regulations are riddled with
 * split conjuncts, and a chip is the last place that damage should surface.
 * The clause is always clean.
 */
export async function corpusTopics({ limit = config.retrieval.suggestionCount } = {}) {
  const { rows } = await query(
    `select distinct on (c.doc_id, c.clause) c.doc_id, c.doc_title, c.clause,
            min(c.chunk_index) as first_seen,
            min(c.page_from) as page
       from bis_chunks c
      where c.clause is not null and btrim(c.clause) <> ''
      group by c.doc_id, c.doc_title, c.clause
      order by c.doc_id, c.clause`
  );

  const perDoc = new Map();
  for (const r of rows) {
    const clause = tidyClause(r.clause);
    if (!clause) continue;
    if (!perDoc.has(r.doc_id)) {
      perDoc.set(r.doc_id, { docTitle: r.doc_title, label: shortDocLabel(r.doc_title), clauses: [] });
    }
    perDoc.get(r.doc_id).clauses.push({ clause, title: clause, docId: r.doc_id, page: r.page });
  }

  for (const d of perDoc.values()) d.clauses.sort((a, b) => clauseOrder(a.clause, b.clause));

  // Round-robin so a small document is not crowded out by a 3,445-chunk one, and
  // so a topic list is never all one document. Deterministic: documents in
  // doc_id order, clauses in numeric-then-lexical order, so the same corpus
  // always yields the same chips.
  const docs = [...perDoc.values()].sort((a, b) => (a.docTitle < b.docTitle ? -1 : 1));
  const ordered = [];
  for (let i = 0; ordered.length < limit && i < 64; i++) {
    for (const d of docs) {
      const t = d.clauses[i];
      if (t) ordered.push({ ...t, docTitle: d.label });
      if (ordered.length >= limit) break;
    }
  }
  return ordered.slice(0, limit);
}

// A bare year is not a clause. The chunker reads the "2018" in "these
// guidelines, 2018" as a section number, and there are 7 such values in the
// current corpus, which in a 6-chip list would be plainly visible.
const CLAUSE_REJECT = /^(19|20)\d{2}$/;
const CLAUSE_MAX = 24;

// Numeric clauses get a sanity check, because the chunker also produces noise
// that a year filter does not catch: `0.15` and `0.0025` in SP 21, and 4-digit
// values like `1008` and `1015` in BIS CA, which are IS standard numbers read
// as section numbers. A real section number is short, and its first part is not
// zero.
const CLAUSE_NUMERIC_OK = /^[1-9]\d{0,2}(?:\.\d{1,3}){0,2}$/;

function tidyClause(raw) {
  const c = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!c || c.length > CLAUSE_MAX) return null;
  if (CLAUSE_REJECT.test(c)) return null;
  if (/^[0-9.]+$/.test(c) && !CLAUSE_NUMERIC_OK.test(c)) return null;
  return c;
}

// 1, 2, 3 … 10, 11 rather than the string order the query returns, which puts
// 10 before 2. Non-numeric clauses ("Appendix A", "Annex A" — there are five
// chunks with them, all real) sort after the numbered ones.
function clauseOrder(a, b) {
  const na = /^[0-9]/.test(a);
  const nb = /^[0-9]/.test(b);
  if (na !== nb) return na ? -1 : 1;
  if (!na) return a < b ? -1 : a > b ? 1 : 0;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10);
    const y = Number.parseInt(pb[i] ?? '0', 10);
    if (x !== y) return x - y;
  }
  return pa.length - pb.length;
}

// Chips are narrow, and SP 21's title is 61 characters. Take the part before an
// em dash where there is one ("SP 21 — Summaries of Indian Standards..." becomes
// "SP 21"), drop a leading article, then prefer a comma boundary over a word
// boundary: "the Bureau of Indian Standards ACT, 2016 NO. 11 of 2016" becomes
// "Bureau of Indian Standards ACT", not "the Bureau of Indian…".
function shortDocLabel(title) {
  let base = String(title ?? '').split(/\s+[—–]\s+/)[0].trim();
  base = base.replace(/^(the|a|an)\s+/i, '').trim() || base;
  if (base.length <= 34) return base;
  const head = base.slice(0, 34);
  const comma = head.lastIndexOf(',');
  if (comma > 12) return head.slice(0, comma).trim();
  const sp = head.lastIndexOf(' ');
  return (sp > 12 ? head.slice(0, sp) : head) + '…';
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
