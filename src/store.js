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
 * Cosine nearest-neighbour search.
 *
 * `<=>` is pgvector's cosine distance, so similarity is 1 - distance. The
 * threshold is applied in SQL so a corpus of irrelevant chunks never reaches the
 * prompt — the model is told to refuse when context is thin, and the cheapest
 * way to guarantee thin context is to not send it.
 *
 * `fetch` is deliberately larger than topK: the threshold may reject the top
 * hits, and `limit` is applied after filtering.
 */
export async function searchChunks({ embedding, topK = 5, threshold, docId = null }) {
  // No default on the parameter itself. A default here silently becomes the real
  // threshold for any caller that forgets to pass one, and config.js should be
  // the only place this number is decided.
  const min = threshold ?? config.retrieval.threshold;
  const fetchCount = Math.max(topK * 4, topK + 5);

  const { rows } = await query(
    `select
        c.id,
        c.doc_id,
        c.doc_title,
        c.page_from,
        c.page_to,
        c.clause,
        c.chunk_index,
        c.content,
        1 - (c.embedding <=> $1::vector) as similarity
    from bis_chunks c
    join bis_documents d on d.doc_id = c.doc_id and d.status = 'ready'
    where 1 - (c.embedding <=> $1::vector) >= $2
      and ($3::text is null or c.doc_id = $3::text)
    order by c.embedding <=> $1::vector
    limit $4`,
    [toVectorLiteral(embedding), min, docId, fetchCount]
  );

  return rows.slice(0, topK).map((r) => ({
    id: r.id,
    docId: r.doc_id,
    docTitle: r.doc_title,
    pageFrom: r.page_from,
    pageTo: r.page_to,
    clause: r.clause,
    chunkIndex: r.chunk_index,
    content: r.content,
    similarity: Number(r.similarity),
  }));
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
