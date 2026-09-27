import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUPPORTED_LANGS, config } from '../src/config.js';
import {
  NOT_FOUND_REPLY,
  GROUNDING_NOTE,
  COVERAGE_HEADER,
  GREETING_REPLY,
  GENERATION_FAILED_REPLY,
  TRANSLATION_FAILED_REPLY,
  NEAR_MISS_LEAD,
  NEAR_MISS_HEADER,
  SUGGESTIONS_HEADER,
  LOCATED_LEAD,
  LOCATED_HEADER,
} from '../src/prompts.js';
import {
  renderNotFoundHtml,
  renderNearMissHtml,
  renderLocatedHtml,
  renderGreetingHtml,
  renderSuggestionsHtml,
  renderSourcesHtml,
  formatTemplate,
  escapeHtml,
} from '../src/render.js';

const LANGS = SUPPORTED_LANGS;

const I18N_SRC = new URL('../public/app-i18n.js', import.meta.url);
const UI_MARKUP = new URL('../public/index.html', import.meta.url);
const UI_SCRIPT = new URL('../public/app.js', import.meta.url);
const UI_CSS = new URL('../public/app.css', import.meta.url);

/**
 * app-i18n.js is `window.I18N = { ... }` with every key quoted, so the object
 * literal is also valid JSON. The assignment is stripped rather than eval'd, so
 * these tests stay a parse of data and never execute the module they inspect.
 */
const I18N = JSON.parse(
  readFileSync(I18N_SRC, 'utf8')
    .replace(/^[\s\S]*?window\.I18N\s*=\s*/, '')
    .replace(/;\s*$/, '')
);

// The UI was one file; a few tests scan it end to end for a removed feature. They
// scan all three files now, or a name could be reintroduced in the stylesheet --
// which is exactly where the camera and mic are still written about.
const ALL_UI = [UI_MARKUP, UI_SCRIPT, UI_CSS]
  .map((u) => readFileSync(u, 'utf8'))
  .join('\n');

test('every user-visible message table covers all four languages', () => {
  // A refusal once existed as one English constant plus a second hardcoded English
  // sentence in render.js, so Hindi and Telugu users got English walls of text.
  const tables = {
    NOT_FOUND_REPLY,
    GROUNDING_NOTE,
    COVERAGE_HEADER,
    GREETING_REPLY,
    GENERATION_FAILED_REPLY,
    TRANSLATION_FAILED_REPLY,
    NEAR_MISS_LEAD,
    NEAR_MISS_HEADER,
    SUGGESTIONS_HEADER,
    LOCATED_LEAD,
    LOCATED_HEADER,
  };

  for (const [name, table] of Object.entries(tables)) {
    assert.equal(typeof table, 'object', `${name} must be a language table, not a bare string`);
    for (const lang of LANGS) {
      assert.equal(typeof table[lang], 'string', `${name} is missing "${lang}"`);
      assert.ok(table[lang].trim().length > 0, `${name}.${lang} is empty`);
    }
  }
});

test('a Hindi refusal is actually in Hindi', () => {
  const en = renderNotFoundHtml({ lang: 'en' });
  const hi = renderNotFoundHtml({ lang: 'hi' });
  assert.notEqual(en, hi, 'the Hindi refusal rendered identically to English');
  assert.ok(/[ऀ-ॿ]/.test(hi), 'Hindi refusal contains no Devanagari');
  assert.ok(!/only answers from the BIS documents/.test(hi), 'English grounding note leaked into the Hindi refusal');
});

test('refusal names the documents the corpus actually contains', () => {
  const html = renderNotFoundHtml({ lang: 'en', coverageTitles: ['SP 21 2005', 'Gazette Notification'] });
  assert.match(html, /SP 21 2005/);
  assert.match(html, /Gazette Notification/);
});

/* ------------------------------------------------------------------ *
 * Dynamic replies: the point of the banding change is that no two
 * refusals read the same and none of them are static text.
 * ------------------------------------------------------------------ */

test('a refusal echoes the query the user actually typed', () => {
  const html = renderNotFoundHtml({ lang: 'en', query: 'fly ash' });
  assert.match(html, /fly ash/);
  // The old copy was the same sentence for every miss, so a canned reply was
  // indistinguishable from a real one.
  const other = renderNotFoundHtml({ lang: 'en', query: 'gold hallmarking' });
  assert.notEqual(html, other, 'two different queries produced an identical refusal');
});

test('a query is escaped before it reaches innerHTML', () => {
  const html = renderNotFoundHtml({ lang: 'en', query: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img'), 'the raw query tag survived into the response HTML');
  assert.match(html, /&lt;img/);
});

test('every {placeholder} is filled in every language', () => {
  // A template that keeps its placeholder renders literal "{query}" to the user.
  const tables = { NOT_FOUND_REPLY, NEAR_MISS_LEAD, LOCATED_LEAD };
  for (const table of Object.values(tables)) {
    for (const lang of LANGS) {
      const filled = formatTemplate(table, lang, { query: 'X' });
      assert.ok(!filled.includes('{query}'), `unfilled placeholder in ${lang}: ${filled}`);
    }
  }
});

test('a near miss names the actual clause it fell back to', () => {
  const html = renderNearMissHtml({
    lang: 'en',
    query: 'brks',
    nearest: {
      clause: '3.2',
      pageFrom: 101,
      pageTo: 102,
      similarity: 0.49,
      content: 'The compressive strength of any individual brick shall not be less than 3.5 MPa.',
    },
  });
  assert.match(html, /brks/);
  assert.match(html, /3\.2/, 'the real clause number is missing');
  assert.match(html, /101/, 'the real page is missing');
  assert.match(html, /compressive strength/, 'the passage text is missing');
  assert.match(html, /49/, 'the real match score is missing');
});

test('a near miss with no passage still reads as a reply, not a crash', () => {
  const html = renderNearMissHtml({ lang: 'en', query: 'zzz', nearest: null });
  assert.match(html, /zzz/);
  assert.ok(html.length > 0);
});

  test('suggestions render as clickable chips carrying their own question', () => {
    const html = renderSuggestionsHtml([
      { clause: '4.2', title: '4.2', docId: 'sp21', docTitle: 'SP 21' },
    ], 'en');
    assert.match(html, /class="ask-suggestion"/);
    assert.match(html, /data-ask="/);
    assert.match(html, /clause 4\.2/);
    assert.match(html, /SP 21/);
    // The chip must name its own document, or the list looks like one corpus
    // when it is five.
    assert.match(html, /What does clause 4\.2 of SP 21 say\?/);
  });

  test('suggestion titles are escaped', () => {
    const html = renderSuggestionsHtml([
      { clause: 'x', title: '<script>alert(1)</script>', docId: 'd', docTitle: '<b>doc</b>' },
    ], 'en');
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>doc</b>'));
  });


test('no suggestions means no empty section', () => {
  assert.equal(renderSuggestionsHtml([], 'en'), '');
  assert.equal(renderSuggestionsHtml(null, 'en'), '');
});

test('a located reply shows the entries it found', () => {
  const html = renderLocatedHtml({
    lang: 'en',
    query: 'fly ash',
    passages: [
      { clause: '1.12', pageFrom: 24, pageTo: 24, similarity: 0.667, content: 'SUMMARY OF PART 1 FLY ASH BASED' },
    ],
  });
  assert.match(html, /fly ash/);
  assert.match(html, /1\.12/);
  assert.match(html, /FLY ASH BASED/);
});

  test('a greeting lists coverage and topics rather than only greeting', () => {
    const html = renderGreetingHtml({
      lang: 'en',
      coverageTitles: ['SP 21'],
      topics: [{ clause: '4.2', title: '4.2', docId: 'sp21', docTitle: 'SP 21' }],
    });
    assert.match(html, /SP 21/);
    assert.match(html, /clause 4\.2/);
  });


/* ------------------------------------------------------------------ *
 * The provenance claim
 * ------------------------------------------------------------------ */

test('sources no longer claim an answer came from a clause', () => {
  // "answered from" asserted grounding that sarvam-1 does not do: it cited
  // "BS EN1985-2017" for a question about Indian bricks while a real SP 21
  // clause was labelled "answered from". For a traceability tool a false
  // verification badge is the worst available failure.
  const passages = [
    { docTitle: 'SP 21', clause: '1.12', pageFrom: 24, pageTo: 24, similarity: 0.66, content: 'x' },
  ];
  const html = renderSourcesHtml(passages, 'en', 1);
  assert.ok(!/answered from/i.test(html), 'the grounding claim is still being rendered');
  assert.ok(!html.includes('answered from'));
});

test('sources state only pipeline facts', () => {
  const passages = [
    { docTitle: 'SP 21', clause: '1.12', pageFrom: 24, pageTo: 24, similarity: 0.66, content: 'x' },
    { docTitle: 'SP 21', clause: '4.1', pageFrom: 24, pageTo: 24, similarity: 0.63, content: 'y' },
  ];
  const html = renderSourcesHtml(passages, 'en', 1);
  assert.match(html, /1\.12/);
  assert.match(html, /4\.1/);
  // The count of passages the model read is a fact, not a claim about the prose.
  assert.match(html, /read by model/);
  assert.equal((html.match(/read by model/g) || []).length, 1, 'the read count does not match');
});

/* ------------------------------------------------------------------ *
 * Frontend string parity
 * ------------------------------------------------------------------ */

  test('the frontend ships the same string keys in all four languages', () => {
    // These live in app-i18n.js, quoted and parseable as JSON, precisely so this
    // check is possible. A missing key renders as the literal string "undefined"
    // next to a real label, which is how a partially-translated UI ships unnoticed.
    const all = I18N;
    const tables = {};

    for (const lang of LANGS) {
      assert.ok(all[lang], `the frontend has no string table for "${lang}"`);
      tables[lang] = all[lang];
    }

  const reference = Object.keys(tables.en).sort();
  assert.ok(reference.length > 15, `only ${reference.length} UI strings found; extraction is broken`);

  for (const lang of LANGS) {
    const keys = Object.keys(tables[lang]).sort();
    const missing = reference.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !reference.includes(k));
    assert.deepEqual(missing, [], `"${lang}" is missing keys`);
    assert.deepEqual(extra, [], `"${lang}" has keys English does not`);
  }
});

  test('no frontend string is left as an unfilled placeholder', () => {
    for (const lang of LANGS) {
      const table = I18N[lang];
      assert.ok(table, `the frontend has no string table for "${lang}"`);
    for (const [key, value] of Object.entries(table)) {
      const placeholders = [...value.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
      for (const p of placeholders) {
        assert.ok(p.length > 1, `${lang}.${key} has a malformed placeholder`);
      }
      assert.ok(!/undefined/.test(value), `${lang}.${key} contains "undefined"`);
    }
  }
});

test('the composer has no dead controls', () => {
  // handleImageUpload and startDictation were wired to the camera and mic buttons
  // but defined nowhere in the file, so both threw a ReferenceError on click.
  // The handlers live in the markup and the functions in the script, so this has
  // to compare across both files to mean anything.
  const html = readFileSync(UI_MARKUP, 'utf8');
  const js = readFileSync(UI_SCRIPT, 'utf8');
  const called = [...html.matchAll(/on(?:click|change|input)="([a-zA-Z_$][\w$]*)\(/g)].map(
    (m) => m[1]
  );
  const defined = new Set(
    [...js.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  );
  for (const fn of called) {
    assert.ok(defined.has(fn), `"${fn}" is wired to the UI but never defined`);
  }
});

test('the frontend offers no UI that the API cannot serve', () => {
  // The old sidebar linked certification, laboratories and hallmarking. All three
  // scored 0.617-0.665 against the real corpus, below the answer threshold, so
  // every one of them produced a guaranteed refusal.
  const html = readFileSync(UI_MARKUP, 'utf8');
  const js = readFileSync(UI_SCRIPT, 'utf8');

  // Match real usages, not prose. The stylesheet explains at the bottom why the
  // camera and mic went away and names them there, so a bare substring scan would
  // trip over the comment that documents the fix.
  const wired = new RegExp(
    `(?:on(?:click|change|input)="|function\\s+)(${['startDictation', 'handleImageUpload'].join('|')})\\b`
  );
  assert.ok(!wired.test(ALL_UI), 'a removed control is still wired up');

  // Nor is there leftover markup for them to live in.
  assert.ok(!/id="(?:micBtn|cameraBtn|cameraInput|micInput)"/.test(html), 'dead control markup remains');

  // The topics list is fetched from the index rather than hardcoded.
  assert.ok(js.includes('/api/topics'), 'the sidebar does not read topics from the index');
  assert.ok(!/hallmark/i.test(ALL_UI), 'the frontend still advertises a subject the corpus lacks');
});
