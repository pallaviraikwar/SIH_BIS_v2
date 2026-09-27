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
    setAttribute(k, v) { this.attrs[k] = v; },
    // Attribute writes are recorded rather than dropped, so a test can assert on
    // what the page script told the DOM -- the theme button's accessible name is
    // set this way, and an empty stub would make that assertion vacuous.
    attrs: {},
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
    themeBtn: makeEl(),
  };
  const inputs = {
    stdSearch: Object.assign(makeEl(), { value: '' }),
    userInput: Object.assign(makeEl(), { value: '' }),
  };
  const requests = [];
  const pending = [];
  const bySelector = new Map();
  // <html> as an attribute recorder, because the theme control's entire mechanism is
  // one attribute: the page script sets data-theme for an explicit choice and
  // removes it for "system". A plain {} would throw on the first set and, worse,
  // would let a test that never looks here pass while the switch does nothing.
  const rootAttrs = new Map();
  const doc = {
    getElementById: (id) => {
      // The i18n tables are read as textContent, the rest as elements. There is no
      // languageSelect any more: the <select> was removed in favour of letting the
      // server detect the script of the question, so nothing reads a chosen value.
      const table = I18N_TABLES[id.replace(/^i18n-/, '')];
      if (id.startsWith('i18n-')) return { textContent: table };
      return containers[id] || inputs[id] || makeEl();
    },
    querySelectorAll: () => [],
    // The citation viewer marks everything outside its own overlay inert while it is
    // open, and those three elements are addressed by selector rather than by
    // id, so the page script looks them up at load. Each selector resolves to one
    // stable element as it would in a browser; anything else resolves to null, so
    // the script's own .filter(Boolean) is exercised the way it is in a browser
    // rather than being handed a truthy stub for every selector.
    querySelector: (sel) => {
      if (!['header', '.wrap', '.composer'].includes(sel)) return null;
      if (!bySelector.has(sel)) bySelector.set(sel, makeEl());
      return bySelector.get(sel);
    },
    addEventListener() {},
    createElement: makeEl,
    documentElement: {
      lang: '',
      setAttribute: (k, v) => rootAttrs.set(k, v),
      removeAttribute: (k) => rootAttrs.delete(k),
      getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
    },
  };

  // A real localStorage, because the theme persists across visits and that is
  // half of what the control does. Backed by a Map so a test can assert what was
  // written without a second boot() having to observe the first one's writes.
  const storage = new Map();

  const sandbox = {
    document: doc,
    // The index drawer closes itself when the viewport leaves the narrow range,
    // which it watches with matchMedia at load, so the page script calls this
    // before any of the sidebar logic under test can run. Handed a query that
    // matches nothing and a change listener that is never called: the stub cannot
    // resize, so all this has to do is exist and accept the subscription.
    window: {
      matchMedia: (query) => ({ matches: false, media: query, addEventListener() {} }),
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    storage,
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
    theme: containers.themeBtn,
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

test('relabelling the panel does not spend an embedding call', async () => {
  // Was "switching language re-labels the panel without another search", back when
  // a <select> drove the language. The assertion is unchanged and still load-bearing:
  // applyLanguage touches labels only. It used to be a real hazard because it called
  // loadTopics() and loadHealth() to refresh sidebar text after a manual switch, and
  // this test is what noticed that those calls doubled. It now calls neither, so the
  // guarantee is structural — but pinning it keeps it that way.
  const p = boot();
  p.type('fees');
  await settle();
  p.searchPending().resolve(ok({ results: [PASSAGE] }));
  await wait(20);
  const searches = p.searchCalls().length;
  const topics = p.topicCalls().length;

  p.sandbox.applyLanguage('hi');
  await wait(20);

  assert.equal(p.searchCalls().length, searches, 'relabelling must not spend an embedding call');
  assert.equal(p.topicCalls().length, topics, 'relabelling must not refetch the sidebar');
  assert.equal(p.sandbox.document.documentElement.lang, 'hi', 'the document language should follow');
});

test('the language <select> is gone and a static hint replaced it', () => {
  // The dropdown was the only way to make the interface speak your language, and it
  // had to be found first. Detection from the query removed the need for it, so its
  // return would be a regression to a worse design.
  assert.ok(!html.includes('languageSelect'), 'the language <select> is back');
  // Matched as a declaration or a call, not a bare substring: the function's own
  // doc comment still names setLanguage when explaining what it replaced.
  assert.ok(
    !/function\s+setLanguage|onchange="setLanguage/.test(html),
    'setLanguage is back; the app should drive applyLanguage'
  );
  assert.match(html, /function applyLanguage\(/, 'applyLanguage should be what switches the labels');
  assert.match(html, /Ask in any language/, 'the hint advertising multilingual input is missing');
  // The request must not carry a pinned language, or detection is overridden by
  // whatever the client last displayed — the original bug.
  assert.match(html, /lang: 'auto'/);
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

test('the theme button drives the data-theme attribute, and system is its absence', async () => {
  // This one is about the theme, and it lives in this file anyway: ui-ux.test.js
  // reads the file as text, and the only way to know that pressing the button
  // actually moves the attribute a real browser would watch is to run the page
  // script. Everything here is a string assertion that would be satisfied by a
  // paintTheme() that did nothing at all.
  const app = boot();
  const root = app.sandbox.document.documentElement;

  // Nothing stored, so nothing forced: the media query has to be left alone, and
  // "system" is expressed by the attribute not being there rather than by a value.
  assert.equal(root.getAttribute('data-theme'), null, 'a first visit forces a theme');
  assert.equal(app.theme.textContent, '◐', 'the button does not start on the system glyph');
  assert.equal(app.theme.attrs['aria-label'], 'Theme: system');

  app.sandbox.cycleTheme();
  assert.equal(root.getAttribute('data-theme'), 'light', 'the first press did not leave "system"');
  assert.equal(app.theme.textContent, '○');
  assert.equal(app.sandbox.storage.get('bis-theme'), 'light', 'the choice was not remembered');

  app.sandbox.cycleTheme();
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(app.theme.textContent, '●');
  assert.match(app.theme.attrs['aria-label'], /dark/);

  // And back round to the system, which has to *remove* the attribute: leaving it
  // set to "auto" would pin the :root[data-theme] blocks with no rule of theirs.
  app.sandbox.cycleTheme();
  assert.equal(root.getAttribute('data-theme'), null, '"system" is stored as a value, so the media query is overridden forever');
  assert.equal(app.theme.textContent, '◐');

  // The label is translated with everything else, so the cycle cannot leave one
  // language's name in the accessible name after a detected language switch.
  app.sandbox.applyLanguage('hi');
  assert.equal(app.theme.attrs['aria-label'], 'थीम: सिस्टम');
  app.sandbox.cycleTheme();
  assert.equal(app.theme.attrs['aria-label'], 'थीम: लाइट');
});
