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
        id,
        doc_id,
        doc_title,
        page_from,
        page_to,
        clause,
        chunk_index,
        content,
        1 - (embedding <=> $1::vector) as similarity
     from bis_chunks
     where 1 - (embedding <=> $1::vector) >= $2
       and ($3::text is null or doc_id = $3::text)
     order by embedding <=> $1::vector
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

export async function getCorpusStats() {  const { rows: [totals] } = await query(
    `select
        (select count(*) from bis_chunks)   as chunk_count,
        (select count(*) from bis_documents) as doc_count`
  );
  const { rows } = await query(
    `select doc_id, doc_title, source_file, page_count, chunk_count, is_scanned, ingested_at
     from bis_documents
     order by doc_title`
  );
  return {
    chunkCount: Number(totals.chunk_count),
    docCount: Number(totals.doc_count),
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
    `select doc_title from bis_documents order by doc_title`
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
