import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

/**
 * The search path, which had no test at all.
 *
 * `searchOnly` threw a ReferenceError on every single call — `bandFor(passes…)`
 * against a local named `passages` — and 240 unit tests plus 8 e2e tests were
 * all green throughout. Two reasons: nothing called `searchOnly`, and
 * `test/retrieval.test.js` imports rag.js statically, so a module mock could
 * never have been registered in time (see the note on mock ordering in
 * doc/architecture.md §10). Hence this file, which mocks first and imports
 * second.
 *
 * It shipped broken because two callers depend on it: `npm run calibrate`, and
 * the sidebar's "Search passages" box, which had been returning 500 for every
 * query and showing the user a generic "server could not be reached" message.
 */

const CHUNKS = [
  { id: 1, docId: 'is.sp.21.2005', docTitle: 'SP 21', clause: '5.1', pageFrom: 101, pageTo: 101,
    chunkIndex: 0, content: '5.1 The moisture content shall not exceed 6.0 percent by mass.', similarity: 0 },
  { id: 2, docId: 'is.sp.21.2005', docTitle: 'SP 21', clause: '5.2', pageFrom: 102, pageTo: 102,
    chunkIndex: 1, content: '5.2 Acid insoluble ash shall not exceed 0.2 percent by mass.', similarity: 0 },
];

/** Scores handed back by the fake retriever, keyed by call order. */
let scores = [];

/**
 * Every export rag.js imports has to be present, or the module fails to
 * instantiate. This list has to track the import block in src/rag.js.
 */
mock.module('../src/store.js', {
  namedExports: {
    searchChunks: async () => [],
    listDocumentTitles: async () => ['SP 21'],
    retrieveHybrid: async ({ topK = 5 }) => {
      // No scores queued means the retriever found nothing at all, which is the
      // case worth testing: an empty corpus must still produce a well-formed
      // answer object rather than throwing on `passages[0]`.
      if (!scores.length) return [];
      return CHUNKS.map((c, i) => ({ ...c, similarity: scores[i] ?? scores[scores.length - 1] })).slice(0, topK);
    },
    corpusTopics: async () => ({ topics: [] }),
  },
});

/* The three string/ranking helpers rag.js imports now live in src/text.js, after
 * they were moved out of store.js for having no database in them. They still have
 * to be stubbed, and stubbing store.js no longer intercepts them — the real
 * parseIsIdentifier would start promoting band from a query this file never
 * intended to exercise. */
mock.module('../src/text.js', {
  namedExports: {
    rotateTopics: async () => ({ topics: [] }),
    parseIsIdentifier: () => null,
    passageHasIdentifier: () => false,
  },
});

mock.module('../src/providers/index.js', {
  namedExports: {
    // A unit vector, so nothing downstream has to care about the real geometry.
    embedQuery: async () => [1, 0, 0],
    generateText: async () => 'unused by the search path',
    // Imported by src/translator.js, which rag.js pulls in. An English query
    // short-circuits before this is called, but the module has to exist for the
    // graph to instantiate at all.
    translateText: async () => 'unused by the search path',
  },
});

// Imported after both mocks, deliberately.
const { searchOnly, bandFor } = await import('../src/rag.js');

/* ------------------------------------------------------------------ *
 * searchOnly
 * ------------------------------------------------------------------ */

test('searchOnly reports a band that agrees with the score it decided on', async () => {
  // The regression this file exists for. `band` was computed from an undeclared
  // `passes` while `topSimilarity` used `passages`, so the function threw before
  // it could return either. Deriving the band from the same value in the test
  // means any future divergence between the two fails here instead of in a
  // user's browser.
  scores = [0.9];
  assert.equal(bandFor(0.9), 'answer');

  const r = await searchOnly('maximum moisture permitted in biscuits', { topK: 1, threshold: 0 });
  assert.equal(r.topSimilarity, 0.9);
  assert.equal(r.band, 'answer');
  assert.equal(r.band, bandFor(r.topSimilarity));
});

test('searchOnly reports the same band for a weak match', async () => {
  // A miss is the interesting direction: a broken band would show "answer" next
  // to a score that could not possibly support one.
  scores = [0.2];
  const r = await searchOnly('gold hallmarking', { topK: 1, threshold: 0 });
  assert.equal(r.band, 'miss');
  assert.equal(r.band, bandFor(r.topSimilarity));
});

test('searchOnly never throws, whatever the retriever returns', async () => {
  // The bug was a ReferenceError, which no amount of correct routing would have
  // caught. This is the blunt version of that guard.
  scores = [];
  const empty = await searchOnly('anything', { topK: 5, threshold: 0 });
  assert.equal(empty.topSimilarity, 0);
  assert.equal(empty.band, 'miss');
  assert.equal(bandFor(0), 'miss');
});

test('a threshold filters the results but allPassages keeps the whole set', async () => {
  // The Quick Directory needs the filtered view; the debugging use of this
  // endpoint needs the near misses the filter hides. Collapsing them would lose
  // the near-miss evidence the band boundaries are chosen against.
  scores = [0.9, 0.3];
  const all = await searchOnly('biscuits', { topK: 5 });
  assert.equal(all.passages.length, 2, 'no threshold means no filtering');

  const filtered = await searchOnly('biscuits', { topK: 5, threshold: config.retrieval.softThreshold });
  assert.equal(filtered.passages.length, 1);
  assert.equal(filtered.passages[0].similarity, 0.9);
  assert.equal(filtered.allPassages.length, 2, 'allPassages is the unfiltered set');
});

test('a threshold of 0 is a filter of everything, not a filter of nothing', async () => {
  // `threshold: 0` is what calibrate passes to see the unfiltered ranking, so a
  // falsy-check bug here would silently empty its output.
  scores = [0.9, 0.3];
  const r = await searchOnly('biscuits', { topK: 5, threshold: 0 });
  assert.equal(r.passages.length, 2);
});

/* ------------------------------------------------------------------ *
 * GET /api/search — the path the sidebar actually calls
 * ------------------------------------------------------------------ */

// Re-mocked so the route sees a searchOnly whose output this file controls. The
// store mock above already covers the real one; this is only to drive the route
// with a known result and to assert on the response shape.
mock.module('../src/rag.js', {
  namedExports: {
    searchOnly: async (q) => ({
      query: q,
      originalQuery: q,
      lang: 'en',
      translated: false,
      topSimilarity: 0.8123,
      band: 'answer',
      passages: [
        { docTitle: 'SP 21', clause: '5.1', pageFrom: 101, pageTo: 101, similarity: 0.8123,
          content: '5.1 The moisture content shall not exceed 6.0 percent by mass.' },
      ],
    }),
  },
});

const { searchRouter } = await import('../src/routes/search.js');

function get(url) {
  return new Promise((done) => {
    const [pathname, queryString = ''] = url.split('?');
    const query = Object.fromEntries(
      new URLSearchParams(queryString).entries()
    );
    const state = { status: 200, headers: {} };
    const res = {
      setHeader(k, v) {
        state.headers[k.toLowerCase()] = v;
        return this;
      },
      status(c) {
        state.status = c;
        return this;
      },
      json(payload) {
        done({ ...state, payload });
        return this;
      },
    };
    searchRouter.handle({ method: 'GET', url: pathname, query, params: {} }, res, (err) =>
      done({ status: 500, payload: { error: 'unhandled', cause: err ? (err.stack ?? err.message) : 'no route matched' } })
    );
  });
}

test('GET /api/search answers the sidebar with a band and a score', async () => {
  // This is the request BIS_Assistant_frontend.html:802 makes. It was returning
  // 500 for every query, and the frontend reported it as a connection failure
  // rather than a server fault.
  const r = await get('/search?q=biscuits&k=8');
  assert.equal(r.status, 200, `status ${r.status}: ${JSON.stringify(r.payload)}`);
  assert.equal(r.payload.count, 1);
  assert.equal(r.payload.band, 'answer');
  assert.equal(r.payload.topSimilarity, 0.8123);
  assert.equal(r.payload.results[0].clause, '5.1');
  // The sidebar renders a "cl. … · p. …" line, so the page list has to survive.
  assert.deepEqual(r.payload.results[0].pages, [101]);
});

test('GET /api/search refuses a query with no q', async () => {
  const r = await get('/search');
  assert.equal(r.status, 400);
  assert.match(r.payload.error, /q=/);
});

test('GET /api/search rejects a blank q rather than searching for nothing', async () => {
  const r = await get('/search?q=%20%20');
  assert.equal(r.status, 400);
});
