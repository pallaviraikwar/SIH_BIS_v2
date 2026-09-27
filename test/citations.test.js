import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { renderSourcesHtml, renderNearMissHtml, renderLocatedHtml, pageLink, citationPanel } from '../src/render.js';
import { config } from '../src/config.js';

const UI_FILE = new URL('../BIS_Assistant_frontend.html', import.meta.url);

/**
 * Verifiable citations.
 *
 * A page reference the reader cannot act on is only marginally better than no
 * page reference. For a standards assistant the entire claim is that an answer
 * came from a specific clause of a specific document, so the citation has to be
 * checkable: a link that opens the real PDF at that page, and the exact text the
 * model was given.
 *
 * The route is the part that can hurt someone, so it is tested like one. The URL
 * carries a docId and never a filename, and the resolved path has to stay inside
 * the corpus directory.
 */

const PASSAGE = {
  docId: 'is.sp.21.2005',
  docTitle: 'SP 21 — Summaries of Indian Standards for Building Materials',
  clause: '2.8',
  pageFrom: 827,
  pageTo: 827,
  similarity: 0.7694,
  content:
    '2.8 TESTING Ready-mixed paints and primers shall be tested in accordance with IS 1012:1983.',
};

/* ------------------------------------------------------------------ *
 * The link
 * ------------------------------------------------------------------ */

test('a page reference links to the document at that page', () => {
  const html = pageLink(PASSAGE, 'p. 827');
  assert.match(html, /href="\/api\/documents\/is\.sp\.21\.2005\/pdf#page=827"/);
  // Plain anchor, deliberately: middle-click and ctrl-click have to work, and
  // there must be no JS that can drift away from the markup.
  assert.match(html, /<a /);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
  assert.match(html, />p\. 827<\/a>/);
});

test('the link carries only a document id, never a path', () => {
  // The route resolves the filename from the database. A docId that looks like a
  // path must still be confined to one URL segment, so the traversal defence
  // never depends on this call site being careful. encodeURIComponent leaves `.`
  // alone but encodes every `/`, which is exactly what is needed here: the value
  // stays a single segment and cannot climb out of /documents/.
  const html = pageLink({ ...PASSAGE, pageFrom: 1, docId: '../../etc/passwd' }, 'p. 1');
  assert.match(html, /href="\/api\/documents\/\.\.%2F\.\.%2Fetc%2Fpasswd\/pdf#page=1"/);
  assert.ok(!/href="[^"]*\/\.\.\//.test(html), 'no unencoded traversal may reach the href');
});

test('a passage with no document is shown as plain text, not a dead link', () => {
  // A link that 404s looks verified and is not, which is worse than no link.
  assert.equal(pageLink({ ...PASSAGE, docId: null }, 'p. 827'), 'p. 827');
  assert.equal(pageLink({ ...PASSAGE, docId: undefined }, 'p. 827'), 'p. 827');
  assert.equal(pageLink({}, 'p. 827'), 'p. 827');
});

test('the page fragment is always a positive integer', () => {
  // Off-by-one here lands the reader on the wrong page, which is the failure the
  // whole feature exists to prevent.
  assert.match(pageLink({ ...PASSAGE, pageFrom: 1 }, 'x'), /#page=1\b/);
  assert.match(pageLink({ ...PASSAGE, pageFrom: 0 }, 'x'), /#page=1\b/);
  assert.match(pageLink({ ...PASSAGE, pageFrom: -5 }, 'x'), /#page=1\b/);
  assert.match(pageLink({ ...PASSAGE, pageFrom: 12.9 }, 'x'), /#page=12\b/);
  assert.equal(pageLink({ ...PASSAGE, pageFrom: undefined }, 'x'), 'x');
  assert.equal(pageLink({ ...PASSAGE, pageFrom: NaN }, 'x'), 'x');
});

/* ------------------------------------------------------------------ *
 * The in-page viewer
 * ------------------------------------------------------------------ */

test('the link carries what the in-page viewer needs', () => {
  // The viewer opens a slide-over instead of a new tab, but it reads these
  // attributes rather than re-parsing the href. They are additive: the href is
  // asserted separately, because with the script blocked it is the only thing
  // left and it has to still work.
  const html = pageLink(PASSAGE, 'p. 827');
  assert.match(html, /data-doc="is\.sp\.21\.2005"/);
  assert.match(html, /data-page="827"/);
  assert.match(html, /data-clause="2\.8"/);
  assert.match(html, /data-title="SP 21 — Summaries of Indian Standards for Building Materials"/);
  assert.match(html, /data-excerpt="2\.8 TESTING Ready-mixed/);
});

test('the viewer excerpt is the same text the panel shows', () => {
  // Two different strings would mean the drawer can disagree with the answer's
  // own evidence, which is the one thing a verification feature must not do.
  const html = pageLink(PASSAGE, 'p. 827');
  const excerpt = html.match(/data-excerpt="([^"]*)"/)[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(excerpt, PASSAGE.content);
});

test('the viewer excerpt is escaped, like every other attribute', () => {
  // data-excerpt is the one attribute holding document text, so it is the one
  // that has to be escaped or a passage containing a quote breaks the markup.
  const html = pageLink({ ...PASSAGE, content: 'He said "5 MPa" & <not> it' }, 'p. 1');
  assert.ok(!html.includes('"5 MPa"'), 'an unescaped quote terminated the attribute');
  assert.match(html, /&quot;5 MPa&quot; &amp; &lt;not&gt;/);
});

test('the viewer still works when the clause is missing', () => {
  // The header falls back to the document, and an empty clause must not print
  // "cl. undefined" the way a missing i18n key used to.
  const html = pageLink({ ...PASSAGE, clause: null, docTitle: null }, 'p. 827');
  assert.match(html, /data-clause=""/);
  assert.match(html, /data-title=""/);
  assert.match(html, /href="\/api\/documents\/is\.sp\.21\.2005\/pdf#page=827"/);
});

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

test('the panel shows the passage text and marks the cited clause', () => {
  const html = citationPanel(PASSAGE);
  assert.match(html, /<details class="cite-panel">/);
  assert.match(html, /<mark>2\.8<\/mark>/);
  // The evidence itself, verbatim, so a claim can be checked rather than trusted.
  assert.match(html, /IS 1012:1983/);
});

test('only the first occurrence of the clause is marked', () => {
  // Marking every occurrence turns a passage into a rash of highlights and makes
  // it impossible to see which one is the cited clause.
  const html = citationPanel({
    ...PASSAGE,
    clause: '2.8',
    content: '2.8 first mention and again 2.8 later',
  });
  assert.equal((html.match(/<mark>/g) ?? []).length, 1);
});

test('a clause that is not in the text is left unmarked', () => {
  // Measured across the corpus, 91.5% of chunks contain their clause somewhere
  // and 8.5% do not. A highlight on the wrong span would tell the reader they
  // had found the clause when they had not, so the correct output is no mark.
  const html = citationPanel({ ...PASSAGE, clause: '99.9', content: 'Nothing like that here.' });
  assert.ok(!html.includes('<mark>'), 'must not invent a highlight');
  assert.match(html, /Nothing like that here\./);
});

test('the marked span is the real clause, not a shifted one', () => {
  // Offsets have to be computed against the escaped text, since escaping changes
  // length. A clause containing an ampersand is the case that breaks otherwise.
  const p = { ...PASSAGE, clause: '5.1 & 5.2', content: 'Requirement 5.1 & 5.2 governs this.' };
  const html = citationPanel(p);
  assert.match(html, /<mark>5\.1 &amp; 5\.2<\/mark>/, 'the mark must wrap the escaped clause itself');
  assert.ok(html.includes('Requirement <mark>'), 'and start in the right place');
});

test('passage text is escaped before it reaches innerHTML', () => {
  // The frontend assigns data.answer to innerHTML, so this is the injection
  // boundary for the panel. The content is text extracted from a PDF, which is
  // untrusted input like anything else.
  const html = citationPanel({ ...PASSAGE, content: '<script>alert(1)</script> & "quotes"' });
  assert.ok(!html.includes('<script>'), 'a script tag must not survive');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;quotes&quot;/);
});

test('a panel with no passage text renders nothing', () => {
  assert.equal(citationPanel({ ...PASSAGE, content: '' }), '');
  assert.equal(citationPanel({ ...PASSAGE, content: '   ' }), '');
  assert.equal(citationPanel({}), '');
});

/* ------------------------------------------------------------------ *
 * The three render sites
 * ------------------------------------------------------------------ */

test('the sources block links the page and offers the panel', () => {
  const html = renderSourcesHtml([PASSAGE], 'en', 1);
  assert.match(html, /#page=827/);
  assert.match(html, /<details class="cite-panel">/);
});

test('a source the model never read gets no verification panel', () => {
  // It was retrieved and ranked but never seen, so offering its text as evidence
  // would be offering something the answer did not come from. The page link stays:
  // it is a real location, just not the basis for the claim.
  const html = renderSourcesHtml([PASSAGE], 'en', 0);
  assert.match(html, /#page=827/);
  assert.ok(!html.includes('cite-panel'), 'must not offer evidence the model did not use');
});

test('the panel label is translated with the answer', () => {
  // An English instruction inside a Hindi answer is the same mismatch that
  // produced a Devanagari reply in an English interface.
  assert.match(renderSourcesHtml([PASSAGE], 'hi', 1), /पाठ दिखाएँ/);
  assert.match(renderSourcesHtml([PASSAGE], 'te', 1), /చూపించండి/);
  assert.match(renderSourcesHtml([PASSAGE], 'pa', 1), /ਦਿਖਾਓ/);
  // No language table: falls back to English rather than rendering the key.
  assert.match(renderSourcesHtml([PASSAGE], 'xx', 1), /Show the text/);
});

test('the near-miss reply links its page too', () => {
  // The bridge already inlines an excerpt, so it needs the link and not a second
  // copy of the text. This is the path an off-corpus question actually takes.
  const html = renderNearMissHtml({ lang: 'en', query: 'plastics', nearest: PASSAGE });
  assert.match(html, /#page=827/);
});

test('the located reply links its page too', () => {
  const html = renderLocatedHtml({ lang: 'en', query: 'IS 1012', passages: [PASSAGE] });
  assert.match(html, /#page=827/);
});

test('a document title cannot inject markup through a citation', () => {
  const html = renderSourcesHtml([{ ...PASSAGE, docTitle: '<img src=x onerror=alert(1)>' }], 'en', 1);
  assert.ok(!html.includes('<img'), 'title must stay escaped');
  assert.match(html, /&lt;img/);
});

/* ------------------------------------------------------------------ *
 * The route
 * ------------------------------------------------------------------ */

const served = [];

mock.module('../src/store.js', {
  namedExports: {
    getCorpusStats: async () => ({ chunkCount: 1, docCount: 1, documents: [] }),
    corpusTopics: async () => ({ topics: [] }),
    getDocumentSource: async (docId) => {
      served.push(docId);
      if (docId === 'is.sp.21.2005') {
        return {
          docId,
          docTitle: 'SP 21',
          sourceFile: 'is.sp.21.2005.pdf',
          pageCount: 929,
          isScanned: false,
        };
      }
      if (docId === 'scanned') {
        return { docId, docTitle: 'Scan', sourceFile: 'scan.pdf', pageCount: 1, isScanned: true };
      }
      if (docId === 'traversal') {
        return { docId, docTitle: 'Evil', sourceFile: '../../../etc/passwd', pageCount: 1, isScanned: false };
      }
      if (docId === 'missing') {
        return { docId, docTitle: 'Gone', sourceFile: 'not-on-disk.pdf', pageCount: 1, isScanned: false };
      }
      return null;
    },
  },
});

const { documentsRouter, resolvePdfPath } = await import('../src/routes/documents.js');

/* ------------------------------------------------------------------ *
 * Route path resolution
 * ------------------------------------------------------------------ *
 * The traversal guard, tested directly. A document title is fine anywhere; a
 * filename is a filesystem path, and `source_file` is written by the ingest
 * script from a user-supplied filename, so it is treated as untrusted here.
 */

const base = path.resolve(config.corpus.pdfDir);

test('a normal filename resolves inside the corpus directory', () => {
  assert.equal(resolvePdfPath('d', 'is.sp.21.2005.pdf'), path.join(base, 'is.sp.21.2005.pdf'));
});

test('traversal out of the corpus directory is refused', () => {
  for (const bad of [
    '../secrets.pdf',
    '../../etc/passwd',
    'a/../../etc/passwd',
    'sub/../../../outside.pdf',
    './../x.pdf',
  ]) {
    assert.equal(resolvePdfPath('d', bad), null, `${bad} must be refused`);
  }
});

test('an absolute path is refused', () => {
  // path.resolve(dir, '/etc/passwd') yields '/etc/passwd'. The prefix check would
  // catch it, but it should never be reached by a legitimate document.
  assert.equal(resolvePdfPath('d', '/etc/passwd'), null);
  assert.equal(resolvePdfPath('d', `${base}/ok.pdf`), null, 'even one inside the base');
});

test('a NUL byte is refused', () => {
  // Truncates the path in some syscalls; rejected before any filesystem call.
  assert.equal(resolvePdfPath('d', 'ok.pdf\0.png'), null);
  assert.equal(resolvePdfPath('d', '\0'), null);
});

test('an empty or non-string filename is refused', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(resolvePdfPath('d', bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test('a sibling directory with a shared prefix is not inside the base', () => {
  // The classic prefix bug: '/corpus-backup' starts with '/corpus' as a string
  // but is not inside it. The check must be on a path separator boundary.
  const sibling = base + '-backup';
  assert.equal(resolvePdfPath('d', path.join(sibling, 'x.pdf')), null);
});


function get(url) {
  return new Promise((done) => {
    const [pathname] = url.split('?');
    // State is held outside the response object and the stubs close over it.
    // Arrow-function stubs have no `this` in a module, so anything relying on it
    // would silently read undefined.
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
      sendFile(p) {
        // Stand in for the real send, and record what it was asked to send so the
        // test can assert on the resolved path and not only the status code.
        done({ ...state, file: p, payload: null });
        return this;
      },
      send(v) {
        done({ ...state, payload: v });
        return this;
      },
    };
    // Express 5 forwards a rejected async handler to next(err). Surface it rather
    // than swallowing it, so a failure here names the cause instead of "500".
    documentsRouter.handle({ method: 'GET', url: pathname, params: { docId: pathname.split('/')[2] } }, res, (err) =>
      done({ status: 500, payload: { error: 'unhandled', cause: err ? (err.stack ?? err.message) : 'no route matched' } })
    );
  });
}

test('a known document is served as an inline PDF', async () => {
  const r = await get('/documents/is.sp.21.2005/pdf');
  assert.equal(r.status, 200, `status ${r.status}: ${JSON.stringify(r.payload)}`);
  assert.equal(r.headers['content-type'], 'application/pdf');
  // `inline`, not `attachment`: clicking "verify this" should open the document,
  // not download it.
  assert.match(r.headers['content-disposition'], /^inline/);
  assert.equal(r.file, path.join(base, 'is.sp.21.2005.pdf'));
});

test('an unknown document is a 404, not a 500', async () => {
  const r = await get('/documents/nope/pdf');
  assert.equal(r.status, 404);
  assert.equal(r.file, undefined);
});

test('a document whose file traverses out of the corpus is refused', async () => {
  // The store is the whitelist, but a source_file containing a traversal sequence
  // must not be able to reach outside pdfDir even so.
  const r = await get('/documents/traversal/pdf');
  assert.equal(r.status, 404);
  assert.equal(r.file, undefined, 'no file may be sent for a traversing source_file');
});

test('a document with no file on disk is a 404', async () => {
  // A stale citation should degrade quietly rather than surface a stack trace.
  const r = await get('/documents/missing/pdf');
  assert.equal(r.status, 404);
  assert.equal(r.file, undefined);
});

test('a scanned document is not offered, because its citation cannot be checked', async () => {
  // A scan has no text layer, so the passage came from somewhere unverifiable.
  // Serving the file would imply a verifiability the ingest step already decided
  // we do not have.
  const r = await get('/documents/scanned/pdf');
  assert.equal(r.status, 404);
  assert.equal(r.file, undefined);
});

test('the route never accepts a filename from the URL', async () => {
  // Only the docId is read. Whatever else is in the path is ignored, so a request
  // naming a file directly cannot retrieve it.
  served.length = 0;
  const r = await get('/documents/is.sp.21.2005/pdf?file=../../etc/passwd');
  assert.equal(r.status, 200);
  assert.deepEqual(served, ['is.sp.21.2005'], `only the docId may be looked up; got ${JSON.stringify(served)}`);
  assert.ok(r.file.startsWith(base), 'and the resolved file stays under the base');
});

test('the citable list only offers documents that can be opened', async () => {
  const r = await get('/documents/citable');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.payload.docIds));
});

/* ------------------------------------------------------------------ *
 * The viewer markup
 *
 * The viewer is the one part of this feature with no browser test. There is no
 * headless browser and no devDependencies in this project, so what can be
 * checked without rendering a page is checked here: the wiring, and the two
 * properties that silently cost a 7.5 MB download or trap keyboard focus.
 * ------------------------------------------------------------------ */

test('the source viewer ships closed and out of the tab order', () => {
  // Without these the panel is focusable while off screen, so a keyboard user
  // tabs into a PDF frame that is not visible.
  const html = readFileSync(UI_FILE, 'utf8');
  const tag = html.match(/<div class="cite-viewer" id="citeViewer"[^>]*>/);
  assert.ok(tag, 'the viewer container is missing');
  assert.match(tag[0], /aria-hidden="true"/);
  assert.match(tag[0], /inert/);
});

test('the viewer frame has no src until a citation is opened', () => {
  // A src here would fetch a 7.5 MB PDF on every page load, before anyone had
  // asked to see a source.
  const html = readFileSync(UI_FILE, 'utf8');
  const frame = html.match(/<iframe[^>]*id="citeViewerFrame"[^>]*>/);
  assert.ok(frame, 'the viewer frame is missing');
  assert.ok(!/\ssrc=/.test(frame[0]), `the frame must not carry a src: ${frame[0]}`);
});

test('every element the viewer script looks up exists in the page', () => {
  // getElementById returns null for a typo, and the failure mode is a click that
  // silently does nothing.
  const html = readFileSync(UI_FILE, 'utf8');
  const wanted = [...html.matchAll(/getElementById\('(cite[A-Za-z]+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 6, `only found ${wanted.length} viewer lookups; extraction is broken`);
  for (const id of new Set(wanted)) {
    assert.ok(html.includes(`id="${id}"`), `the script reads #${id} but the page has no such element`);
  }
});

test('the viewer can always be dismissed', () => {
  // Three routes out: the scrim, the button, Escape. A panel you can only close
  // by reloading is a trap on a touch device, where Escape does not exist.
  const html = readFileSync(UI_FILE, 'utf8');
  assert.ok(/class="cite-viewer-scrim"[^>]*data-cite-close/.test(html), 'the scrim does not close the viewer');
  assert.ok(/class="cite-viewer-x"[^>]*data-cite-close/.test(html), 'the close button is not wired');
  assert.match(html, /e\.key === 'Escape'/, 'Escape does not close the viewer');
});

test('the viewer offers a way out of the frame', () => {
  // #page= seeking inside a frame is unverified in Safari. The passage above the
  // frame is the primary evidence, and this link is the fallback when the frame
  // opens on the wrong page.
  const html = readFileSync(UI_FILE, 'utf8');
  const link = html.match(/<a[^>]*id="citeViewerNewTab"[^>]*>/);
  assert.ok(link, 'the fallback link is missing');
  assert.match(link[0], /target="_blank"/);
  assert.match(link[0], /data-i18n="openNewTab"/);
});

test('a citation link still works with the script disabled', () => {
  // The only guarantee that survives a JS error, a stripped build or an
  // extension blocking the handler: the anchor is a real link to a real page.
  const html = pageLink(PASSAGE, 'p. 827');
  const href = html.match(/href="([^"]+)"/);
  assert.ok(href, 'the anchor has no href');
  assert.equal(href[1], '/api/documents/is.sp.21.2005/pdf#page=827');
});
