import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/**
 * The Quick Directory is the one piece of frontend logic with real failure modes:
 * every search costs a Gemini embedding call, the results are assigned through
 * innerHTML, and responses can arrive out of order. It is a single <script> block
 * inside the HTML, so the real code is loaded and exercised here against a small
 * DOM stub rather than a reimplementation that could drift from it.
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'BIS_Assistant_frontend.html'), 'utf8');

function makeEl() {
  return {
    innerHTML: '',
    dataset: {},
    addEventListener() {},
    appendChild() {},
    classList: { add() {}, remove() {} },
    scrollIntoView() {},
  };
}

/** Boots the page script with a stubbed DOM and a manually-resolved fetch. */
function boot() {
  const containers = { searchResults: makeEl(), chatBox: makeEl() };
  const inputs = {
    stdSearch: Object.assign(makeEl(), { value: '' }),
    userInput: Object.assign(makeEl(), { value: '' }),
  };
  const requests = [];
  const pending = [];
  let langSelect = { value: 'en' };

  const doc = {
    getElementById: (id) => (id === 'languageSelect' ? langSelect : containers[id] || inputs[id] || makeEl()),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: makeEl,
  };

  const sandbox = {
    document: doc,
    window: {},
    location: { protocol: 'http:' },
    setTimeout,
    clearTimeout,
    console,
    // Each call records its URL and stays in flight until the test settles it,
    // which is what makes out-of-order completion testable.
    fetch: (url) => {
      requests.push(url);
      return new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);

  return {
    sandbox,
    requests,
    pending,
    results: containers.searchResults,
    box: inputs.stdSearch,
    setLang: (v) => { langSelect = { value: v }; },
    /** Simulates typing `text` one character at a time. */
    type(text) {
      this.box.value = '';
      for (const ch of text) {
        this.box.value += ch;
        this.sandbox.handleQuickSearch();
      }
    },
    searchCalls: () => requests.filter((u) => u.includes('/api/search')),
    documentCalls: () => requests.filter((u) => u.includes('/api/documents')),
  };
}

const PASSAGE = {
  docTitle: 'Gazette Notification Of Hallmarking Published',
  clause: '2',
  pages: [3],
  similarity: 0.7041,
  preview: 'Hallmark <script>alert(1)</script> & Bureau rules',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Longer than the 350ms debounce. */
const settle = () => wait(500);
const ok = (res) => ({ ok: true, json: async () => res });

test('debounces a burst of keystrokes into a single request', async () => {
  const p = boot();
  for (const ch of 'hallmarking') {
    p.box.value += ch;
    p.sandbox.handleQuickSearch();
    await wait(10);
  }
  await settle();
  assert.equal(p.searchCalls().length, 1, '11 keystrokes must not cost 11 embeddings');
  assert.match(p.searchCalls()[0], /q=hallmarking/);
  assert.ok(!p.searchCalls()[0].includes('threshold'), 'client must not override the server threshold');
});

test('ignores queries shorter than the minimum', async () => {
  const p = boot();
  p.type('is');
  await settle();
  assert.equal(p.searchCalls().length, 0);
  assert.equal(p.documentCalls().length, 1, 'should fall back to listing the corpus');
});

test('renders a result card and escapes document text', async () => {
  const p = boot();
  p.type('hallmarking');
  await settle();
  p.pending[0].resolve(ok({ results: [PASSAGE] }));
  await wait(20);

  const out = p.results.innerHTML;
  assert.match(out, /result-card/);
  assert.ok(!out.includes('<script>'), 'preview must be escaped before innerHTML');
  assert.match(out, /&amp;/);
  assert.match(out, /cl\. 2/);
  assert.match(out, /70% match/);
  assert.match(
    out,
    /data-ask="Tell me about Gazette Notification Of Hallmarking Published, clause 2"/,
    'click target must be a data attribute, not an inline JS string'
  );
});

test('discards a stale response that arrives after a newer one', async () => {
  const p = boot();
  p.type('fees');
  await settle();
  const stale = p.pending[0];

  p.type('gold');
  await settle();
  const fresh = p.pending[1];

  // Newer request answers first, then the older one lands late.
  fresh.resolve(ok({ results: [{ ...PASSAGE, docTitle: 'FRESH', clause: '9' }] }));
  await wait(20);
  stale.resolve(ok({ results: [{ ...PASSAGE, docTitle: 'STALE' }] }));
  await wait(20);

  assert.match(p.results.innerHTML, /FRESH/);
  assert.ok(!p.results.innerHTML.includes('STALE'), 'late stale response overwrote newer results');
});

test('shows an error instead of throwing when the server is unreachable', async () => {
  const p = boot();
  p.type('fees');
  await settle();
  p.pending[0].reject(new Error('ECONNREFUSED'));
  await wait(20);
  assert.match(p.results.innerHTML, /Cannot reach/);
});

test('reports zero matches honestly', async () => {
  const p = boot();
  p.type('biscuit');
  await settle();
  p.pending[0].resolve(ok({ results: [] }));
  await wait(20);
  assert.match(p.results.innerHTML, /No matching passage/);
});

test('lists the real corpus when the query is empty', async () => {
  const p = boot();
  p.sandbox.loadCorpusList();
  await wait(20);
  p.pending[0].resolve(ok({
    documents: [{ docTitle: 'Gazette Notification', sourceFile: 'Gazette-Notification.pdf', pageCount: 2, chunkCount: 9 }],
  }));
  await wait(20);
  const out = p.results.innerHTML;
  assert.match(out, /Gazette Notification/);
  assert.match(out, /2 pages/);
  assert.match(out, /9 passages/);
});

test('switching language re-labels the panel without another request', async () => {
  const p = boot();
  p.type('fees');
  await settle();
  p.pending[0].resolve(ok({ results: [{ ...PASSAGE, clause: '5', pages: [1, 2], similarity: 0.61 }] }));
  await wait(20);
  const before = p.requests.length;

  p.setLang('hi');
  p.sandbox.updateLanguage();
  await wait(20);

  assert.equal(p.requests.length, before, 'language switch must not spend an embedding call');
  assert.match(p.results.innerHTML, /खंड 5/);
  assert.match(p.results.innerHTML, /61% मेल/);
});

test('contains no hardcoded standard data', () => {
  assert.ok(!html.includes('mockStandardsDB'), 'fabricated standards list is back');
  for (const code of ['IS 1011', 'IS 14543', 'IS 1293', 'IS 302']) {
    assert.ok(!html.includes(code), `${code} is not in the corpus and must not be advertised`);
  }
});
