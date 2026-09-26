import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/**
 * The sidebar is the one piece of frontend logic with real failure modes: every
 * search costs an embedding call, the results are assigned through innerHTML, and
 * responses can arrive out of order. It is a single <script> block inside the HTML,
 * so the real code is loaded and exercised here against a small DOM stub rather
 * than a reimplementation that could drift from it.
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'BIS_Assistant_frontend.html'), 'utf8');

/**
 * The page keeps its UI strings in <script type="application/json"> blocks so a
 * test can diff the four languages for missing keys. The stub therefore has to
 * hand those tables back verbatim, or the page's own first line of script throws
 * on JSON.parse(undefined) before any of this logic runs.
 */
const I18N_TABLES = Object.fromEntries(
  ['en', 'hi', 'pa', 'te'].map((lang) => [
    lang,
    html.match(
      new RegExp(`<script type="application/json" id="i18n-${lang}">([\\s\\S]*?)</script>`)
    )[1],
  ])
);

function makeEl() {
  return {
    innerHTML: '',
    dataset: {},
    addEventListener() {},
    appendChild() {},
    remove() {},
    classList: { add() {}, remove() {} },
    scrollIntoView() {},
    focus() {},
    textContent: '',
    value: '',
  };
}

/** Boots the page script with a stubbed DOM and a manually-resolved fetch. */
function boot() {
  const containers = {
    searchResults: makeEl(),
    chatBox: makeEl(),
    topicList: makeEl(),
  };
  const inputs = {
    stdSearch: Object.assign(makeEl(), { value: '' }),
    userInput: Object.assign(makeEl(), { value: '' }),
  };
  const requests = [];
  const pending = [];
  let langSelect = { value: 'en' };

  const doc = {
    getElementById: (id) => {
      if (id === 'languageSelect') return langSelect;
      // The i18n tables are read as textContent, the rest as elements.
      const table = I18N_TABLES[id.replace(/^i18n-/, '')];
      if (id.startsWith('i18n-')) return { textContent: table };
      return containers[id] || inputs[id] || makeEl();
    },
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: makeEl,
    documentElement: {},
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
    topics: containers.topicList,
    box: inputs.stdSearch,
    setLang: (v) => { langSelect = { value: v }; },
    /** Simulates typing `text` one character at a time. */
    type(text) {
      this.box.value = '';
      for (const ch of text) {
        this.box.value += ch;
        this.sandbox.onSearchInput();
      }
    },
    searchCalls: () => requests.filter((u) => u.includes('/api/search')),
    topicCalls: () => requests.filter((u) => u.includes('/api/topics')),
    /**
     * Pending requests by URL, not by arrival order. The page fetches topics and
     * health on boot, so pending[0] is not the search the test just triggered.
     */
    pendingFor: (needle) => pending.filter((x) => x.url.includes(needle)),
    searchPending: (i = 0) => pending.filter((x) => x.url.includes('/api/search'))[i],
  };
}

const PASSAGE = {
  docTitle: 'SP 21 2005',
  clause: '3.2',
  pages: [101, 102],
  similarity: 0.7041,
  preview: 'Lime <script>alert(1)</script> & burnt bricks',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Longer than the 300ms debounce. */
const settle = () => wait(500);
const ok = (res) => ({ ok: true, json: async () => res });

test('debounces a burst of keystrokes into a single request', async () => {
  const p = boot();
  for (const ch of 'hallmarking') {
    p.box.value += ch;
    p.sandbox.onSearchInput();
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
  assert.equal(p.searchCalls().length, 0, 'a two-character query still spent an embedding call');
  assert.match(p.results.innerHTML, /Type to search/);
});

test('an empty search box shows the hint rather than a blank panel', async () => {
  // Otherwise the panel is simply empty on first paint and the user cannot tell
  // whether the feature exists.
  const p = boot();
  await wait(20);
  assert.match(p.results.innerHTML, /Type to search/);
});

test('renders a result card and escapes document text', async () => {
  const p = boot();
  p.type('bricks');
  await settle();
  p.searchPending().resolve(ok({ results: [PASSAGE] }));
  await wait(20);

  const out = p.results.innerHTML;
  assert.match(out, /dir-card/);
  assert.ok(!out.includes('<script>'), 'preview must be escaped before innerHTML');
  assert.match(out, /&amp;/);
  assert.match(out, /cl\. 3\.2/);
  assert.match(out, /101–102/);
  assert.match(
    out,
    /data-ask="Tell me about SP 21 2005, clause 3\.2"/,
    'click target must be a data attribute, not an inline JS string'
  );
});

test('a card with no clause still produces a usable click target', async () => {
  const p = boot();
  p.type('bricks');
  await settle();
  p.searchPending().resolve(ok({ results: [{ ...PASSAGE, clause: null, pages: [7] }] }));
  await wait(20);
  assert.match(p.results.innerHTML, /data-ask="Tell me about SP 21 2005"/);
  assert.match(p.results.innerHTML, /cl\. —/, 'a missing clause should read as a dash, not "null"');
});

test('discards a stale response that arrives after a newer one', async () => {
  const p = boot();
  p.type('fees');
  await settle();
  const stale = p.searchPending(0);

  p.type('gold');
  await settle();
  const fresh = p.searchPending(1);

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
  p.searchPending().reject(new Error('ECONNREFUSED'));
  await wait(20);
  assert.match(p.results.innerHTML, /Cannot reach/);
});

test('reports zero matches honestly', async () => {
  const p = boot();
  p.type('biscuit');
  await settle();
  p.searchPending().resolve(ok({ results: [] }));
  await wait(20);
  assert.match(p.results.innerHTML, /No matching passage/);
});

test('the topic list is read from the index, and an empty index is not a crash', async () => {
  const p = boot();
  await wait(20);
  const first = p.topicCalls().length;
  p.pendingFor('/api/topics')[0].resolve(ok({ topics: [] }));
  await wait(20);
  assert.equal(p.topicCalls().length, first, 'a failed topic fetch must not retry in a loop');
});

test('switching language re-labels the panel without another search', async () => {
  const p = boot();
  p.type('fees');
  await settle();
  p.searchPending().resolve(ok({ results: [PASSAGE] }));
  await wait(20);
  const searches = p.searchCalls().length;

  p.setLang('hi');
  p.sandbox.setLanguage('hi');
  await wait(20);

  assert.equal(p.searchCalls().length, searches, 'language switch must not spend an embedding call');
});

test('contains no hardcoded standard data', () => {
  assert.ok(!html.includes('mockStandardsDB'), 'fabricated standards list is back');
  // Certification, laboratories and hallmarking were all linked from the old
  // sidebar and all scored below the answer threshold, so every one was a
  // guaranteed refusal. The index supplies the topics instead.
  for (const code of ['IS 1011', 'IS 14543', 'IS 1293', 'IS 302']) {
    assert.ok(!html.includes(code), `${code} is not in the corpus and must not be advertised`);
  }
  for (const subject of ['certification', 'laborator', 'hallmark']) {
    assert.ok(!html.includes(subject), `${subject} is not in the corpus and must not be advertised`);
  }
});
