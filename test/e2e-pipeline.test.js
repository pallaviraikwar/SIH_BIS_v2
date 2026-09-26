/**
 * End-to-end pipeline proof WITHOUT Postgres.
 *
 * Docker socket access is unavailable in this environment, so this harness
 * swaps the pgvector store for an in-memory cosine search and drives the real
 * translator -> embedder -> retriever -> generator -> renderer chain against the
 * live Gemini API. It validates everything except the SQL itself.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const CHUNKS = [];
const l2 = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
};
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// --- fake the vector store before rag.js is imported ------------------------
mock.module('../src/store.js', {
  namedExports: {
    searchChunks: async ({ embedding, topK = 5, threshold = 0 }) =>
      CHUNKS.map((c) => ({ ...c, similarity: cos(embedding, c.embedding) }))
        .filter((c) => c.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK),
    getCorpusStats: async () => ({ chunkCount: CHUNKS.length, docCount: 3, documents: [] }),
    replaceDocumentChunks: async () => {},
  },
});

const { embedDocuments } = await import('../src/gemini.js');
const { chunkDocument, toEmbeddableText } = await import('../src/chunker.js');
const { answerQuestion } = await import('../src/rag.js');
const { config } = await import('../src/config.js');

// --- a realistic little BIS corpus, with real clause numbering --------------
const DOCS = [
  {
    docId: 'is-1011-2002',
    title: 'IS 1011:2002 Biscuits',
    pages: [
      { pageNumber: 1, text: '1 SCOPE\nThis standard covers the manufacture and quality requirements of biscuits, cookies and wafers.\n\n5 REQUIREMENTS\n5.1 Moisture\nThe moisture content shall not exceed 6.0 percent by mass.\n\n5.2 Acid Insoluble Ash\nThe acid insoluble ash shall not exceed 0.05 percent on a dry basis.' },
      { pageNumber: 2, text: '6 SAMPLING AND TESTING\nSampling shall be carried out in accordance with Annex A. The acidity of extracted fat shall not exceed 1.5 percent.' },
    ],
  },
  {
    docId: 'is-14543-2024',
    title: 'IS 14543:2024 Packaged Drinking Water',
    pages: [
      { pageNumber: 1, text: '5 REQUIREMENTS\n5.1 Microbiological\nThe product shall be free from Escherichia coli in any 100 ml sample.\n\n5.2 Chemical\nTotal dissolved solids shall not exceed 2000 mg per litre. Lead shall not exceed 0.01 mg per litre and arsenic shall not exceed 0.01 mg per litre.' },
      { pageNumber: 2, text: '6 MARKING\nEach package shall bear the ISI mark, the total dissolved solids value, and the name of the manufacturer.' },
    ],
  },
  {
    docId: 'is-1489-part-1-2015',
    title: 'IS 1489:2015 Portland Pozzolana Cement',
    pages: [
      { pageNumber: 1, text: '5 REQUIREMENTS\n5.1 Compressive Strength\nThe compressive strength of cement mortar at 28 days shall not be less than 43.0 MPa.\n\n5.2 Setting Time\nThe initial setting time shall not exceed 30 minutes and final setting time shall not exceed 600 minutes.' },
    ],
  },
];

test('embed the corpus with the real embedder', async () => {
  let n = 0;
  for (const d of DOCS) {
    const chunks = chunkDocument({ docId: d.docId, docTitle: d.title, pages: d.pages });
    const vectors = await embedDocuments(chunks.map((c) => ({ text: toEmbeddableText(c), title: d.title })));
    chunks.forEach((c, i) => {
      CHUNKS.push({ ...c, embedding: vectors[i] });
      n++;
    });
  }
  console.log(`\n  embedded ${n} chunks from ${DOCS.length} documents`);
  assert.ok(n >= 6, `expected >=6 chunks, got ${n}`);

  const withClause = CHUNKS.filter((c) => c.clause).length;
  console.log(`  clause-tagged chunks: ${withClause}/${n}`);
  assert.ok(withClause >= 4, 'clause detection should tag most chunks');
});

test('grounded answer: moisture limit in biscuits', async () => {
  const r = await answerQuestion({ query: 'What is the maximum moisture content allowed in biscuits?', lang: 'en' });

  console.log(`\n  retrieved=${r.meta.retrieved}  notFound=${r.notFound}`);
  r.sources.forEach((s) => console.log(`    [${s.similarity}] ${s.docTitle} cl.${s.clause ?? '-'} p.${s.pages.join('-')}`));
  console.log('\n--- ANSWER HTML ---\n' + r.answer + '\n------------------');

  assert.equal(r.notFound, false, 'should answer, not refuse');
  assert.ok(/6\.0 percent/.test(r.answer), 'must contain the 6.0 percent limit');
  assert.ok(r.sources.length > 0, 'must cite sources');
  assert.ok(r.sources[0].docTitle.includes('1011'), 'top source should be the biscuits standard');
  assert.ok(r.answer.includes('cl. 5.1'), 'must cite the clause number');
  assert.ok(r.answer.includes('class="cite"'), 'citation markers must be rendered');
  assert.ok(!r.answer.includes('<script'), 'no raw script tags');
});

test('adversarial: question not in the corpus must be refused', async () => {
  const r = await answerQuestion({ query: 'How do I apply for a passport at the Bangalore consulate?', lang: 'en' });
  console.log(`\n  retrieved=${r.meta.retrieved}  notFound=${r.notFound}  reason=${r.meta.reason ?? 'model declined'}`);
  console.log('\n--- ANSWER HTML ---\n' + r.answer + '\n------------------');

  assert.equal(r.notFound, true, 'must refuse rather than invent');
  assert.ok(r.answer.includes('could not find'), 'should show the not-found copy');
  assert.ok(!/\b\d+(\.\d+)?\s*(MPa|mg|percent)\b/.test(r.answer), 'must not invent a numeric limit');
});

test('multilingual: Hindi question about cement returns English citations', async () => {
  const r = await answerQuestion({ query: 'सीमेंट की 28 दिन की compressive strength कितनी होनी चाहिए?', lang: 'hi' });
  console.log(`\n  translated=${r.meta.translationUsed}  retrievalQuery="${r.meta.retrievalQuery}"`);
  console.log('--- ANSWER (text) ---\n' + r.answerText + '\n------------------');

  assert.equal(r.meta.translationUsed, true, 'should have translated to English');
  assert.ok(r.sources.length > 0, 'should retrieve something');
  assert.ok(r.sources[0].docTitle.includes('1489'), `top source should be cement, got ${r.sources[0]?.docTitle}`);
  assert.ok(/43\.0/.test(r.answerText ?? r.answer), 'must contain 43.0 MPa');
  assert.ok(/[ऀ-ॿ]/.test(r.answerText ?? r.answer), 'must answer in Devanagari');
});

test('English query skips the translation call entirely', async () => {
  const r = await answerQuestion({ query: 'What is the total dissolved solids limit?', lang: 'en' });
  assert.equal(r.meta.translationUsed, false, 'no translation needed for English');
  assert.ok(r.sources[0].docTitle.includes('14543'), `top source should be water, got ${r.sources[0]?.docTitle}`);
  console.log(`\n  top source: ${r.sources[0].docTitle} (${r.sources[0].similarity})`);
  console.log(`  timings: translate=${r.meta.timings.translate} retrieve=${r.meta.timings.retrieve} generate=${r.meta.timings.generate}`);
});
