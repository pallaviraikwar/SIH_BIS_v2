'use strict';

  const LANGS = ['en', 'hi', 'pa', 'te'];
  // app-i18n.js sets window.I18N and is a <script> in the head, so the tables are
  // already parsed by the time this runs. t() is called during first paint, so
  // waiting on a fetch for them here would mean rendering untranslated text first.
  const I18N = window.I18N;

let lang = 'en';
const t = (key) => I18N[lang][key] ?? I18N.en[key] ?? key;
const fill = (key, vars) =>
    Object.entries(vars).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));

// Served from the same origin as the API, but the file also has to work when
// opened straight from disk, where "/api/..." would resolve to file:///api/...
const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : '';

const chatBox = document.getElementById('chatBox');
const input = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');

// Must match .composer textarea max-height in app.css. Past this the box scrolls
// rather than growing, so a pasted standard number cannot push the transcript
// off the top of the screen.
const INPUT_MAX_H = 190;

/* The textarea grows with what is typed, up to INPUT_MAX_H.

   Height is reset to 'auto' before measuring, because scrollHeight of a textarea
   is its *content* height only when the box is not already taller than it -- so
   without the reset the box can shrink on deletion but never grows past the
   height it has already reached, and a second longer question scrolls instead. */
function resizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, INPUT_MAX_H) + 'px';
}

input.addEventListener('input', resizeInput);

/* main reserves the composer's height so a grown textarea cannot cover the last
   answer. The textarea's growth changes that height, so it is observed rather
   than recomputed on every keystroke; the fallback branch covers a browser
   without ResizeObserver, where the initial 96px in app.css stands. */
function resizeComposer() {
    const box = document.querySelector('.composer');
    if (!box) return;
    document.documentElement.style.setProperty('--composer-h', box.offsetHeight + 'px');
}

const composerEl = document.querySelector('.composer');
if (composerEl) {
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(resizeComposer).observe(composerEl);
    } else {
        resizeComposer();
    }
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Suggestion buttons arrive as server-rendered HTML inside an answer, so they are
// wired by delegation. Reading data-ask rather than an inline onclick also means a
// title containing an apostrophe cannot break out of a JS string literal.
//
// Delegation is bound to all three lists that can hold a button. Binding it only to
// the transcript looked fine and left the whole sidebar inert: the topic buttons in
// #topicList and the passage cards in #searchResults are siblings of the transcript,
// not descendants, so no click ever reached the handler.
for (const host of [chatBox, document.getElementById('topicList'), document.getElementById('searchResults')]) {
    host.addEventListener('click', (e) => {
        const b = e.target.closest('.ask-suggestion, .side-btn, .dir-card');
        if (b && b.dataset.ask) {
            e.preventDefault();
            ask(b.dataset.ask);
        }
    });
}

/* ---------- index drawer ----------
   Below 860px the sidebar is an overlay rather than a column, because it is the
   only route to passage search and to the topic list and `display: none` at that
   width made both of them absent on a phone. It keeps the same contract as the
   citation viewer below, on purpose: inert background, focus moved in, focus
   returned, Escape out, and three ways to close that do not involve a reload. */

const sidePanel = document.getElementById('sidePanel');
const sideToggle = document.getElementById('sideToggle');
const sideScrim = document.getElementById('sideScrim');

// 'main' rather than the viewer's '.wrap', and the difference is load-bearing:
// the drawer is a child of .wrap, so marking .wrap inert would take the drawer
// down along with the page it is meant to be covering.
const sideBackground = ['header', 'main', '.composer']
    .map((sel) => document.querySelector(sel))
    .filter(Boolean);

const NARROW_QUERY = '(max-width: 860px)';
let sideOpen = false;

function toggleSidebar() {
    if (sideOpen) closeSidebar();
    else openSidebar();
}

function openSidebar() {
    if (sideOpen) return;
    sideOpen = true;
    sidePanel.classList.add('open');
    sideScrim.classList.add('on');
    sideToggle.setAttribute('aria-expanded', 'true');
    // Background before focus, for the reason the viewer does it: the toggle is
    // inside `header`, and the browser blurs it as `header` goes inert, so
    // moving focus on the same tick leaves no frame with focus nowhere.
    sideBackground.forEach((el) => el.setAttribute('inert', ''));
    // The × , not the search box. Opening the drawer on a phone is as often about
    // browsing the topic list, and focusing a text field raises the on-screen
    // keyboard over the drawer the reader was trying to look at.
    sidePanel.querySelector('.side-x').focus();
}

function closeSidebar() {
    if (!sideOpen) return;
    sideOpen = false;
    sidePanel.classList.remove('open');
    sideScrim.classList.remove('on');
    sideToggle.setAttribute('aria-expanded', 'false');
    // Lifted before the focus restore: the trigger is inside `header`, and
    // focusing a descendant of an inert subtree silently does nothing.
    sideBackground.forEach((el) => el.removeAttribute('inert'));
    sideToggle.focus();
}

sideScrim.addEventListener('click', closeSidebar);

// Two reasons to close from inside the panel. The × is the explicit control; the
// second is the one that is easy to forget -- picking a topic or a search result
// asks the question, and the answer renders in the transcript *behind* the
// drawer, so leaving it open hides the thing that was just asked for.
sidePanel.addEventListener('click', (e) => {
    if (e.target.closest('[data-side-close], [data-ask]')) closeSidebar();
});

/* Closing on the way out of the narrow range. Above 860px the drawer rules stop
   applying and the sidebar is a static column again -- but the `inert` set on the
   background is script, not CSS, so without this a tablet rotating out of portrait
   would leave the whole app dead to clicks and to focus. */
window.matchMedia(NARROW_QUERY).addEventListener('change', (e) => {
    if (!e.matches) closeSidebar();
});

/* ---------- theme ---------- */

// Three modes rather than two, and that is the whole design decision. A two-state
// toggle leaves anyone who wants the page to go back to following their system with
// no way to say so, and "system" is the state every install starts in -- so it has
// to be reachable, not just escapable.
const THEME = {
    auto: { glyph: '◐', nameKey: 'modeAuto' },
    light: { glyph: '○', nameKey: 'modeLight' },
    dark: { glyph: '●', nameKey: 'modeDark' },
};
const THEME_MODES = Object.keys(THEME);
const THEME_STORE_KEY = 'bis-theme';
const themeBtn = document.getElementById('themeBtn');
let themeMode = 'auto';

function readStoredTheme() {
    // Wrapped because localStorage throws outright, not just returns null, in a
    // sandboxed frame and in some privacy modes, and a theme switch is not worth a
    // page that will not boot. An unreadable or unrecognised value falls back to
    // "system", which is also the safe answer: it is the one mode that needs
    // nothing remembered about the person who set it.
    try {
        const saved = localStorage.getItem(THEME_STORE_KEY);
        return THEME_MODES.includes(saved) ? saved : 'auto';
    } catch (e) {
        return 'auto';
    }
}

function paintTheme() {
    // The attribute is only ever *set*, never cleared to a value: "system" is its
    // absence. That is what lets prefers-color-scheme keep answering on its own for
    // everyone who has not made a choice, including on the very first paint, before
    // this script has run.
    if (themeMode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', themeMode);

    themeBtn.textContent = THEME[themeMode].glyph;
    // One key for the whole label, so the button names the mode it is in rather than
    // the one a press would move to. With a cycle, "what does this do" is only
    // answerable by pressing it, and an accessible name has to stand on its own.
    const label = fill('themeLabel', { mode: t(THEME[themeMode].nameKey) });
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
}

function cycleTheme() {
    themeMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
    paintTheme();
    try {
        localStorage.setItem(THEME_STORE_KEY, themeMode);
    } catch (e) { /* not fatal: the page has already switched, it just will not persist */ }
}

/* ---------- in-page source viewer ---------- */

const citeViewer = document.getElementById('citeViewer');
const citeFrame = document.getElementById('citeViewerFrame');
const citeTitle = document.getElementById('citeViewerTitle');
const citeMeta = document.getElementById('citeViewerMeta');
const citeExcerpt = document.getElementById('citeViewerExcerpt');
const citeNewTab = document.getElementById('citeViewerNewTab');

// The link that opened the viewer, so focus can go back where it came from.
let citeReturnFocus = null;

// Everything the modal covers. The panel declares aria-modal="true", which is a
// promise that focus and assistive technology stay inside it -- but nothing was
// keeping that promise, so Tab walked straight out of the dialog and into the
// transcript behind the scrim. Marking the rest of the document inert while the
// drawer is open is the way to actually keep it, and it is cheaper and more
// robust than a hand-rolled keydown trap: native, so it also stops a screen
// reader reading the background, and it reuses the mechanism already used on the
// panel itself.
const citeBackground = ['header', '.wrap', '.composer']
    .map((sel) => document.querySelector(sel))
    .filter(Boolean);

// The clause is re-marked here rather than shipped as markup, because the server
// already renders a marked copy into the <details> panel and a second rendered
// copy in an attribute would be a third thing to keep in sync.
//
// The escaping round trip is the whole reason this function exists in this shape.
// pageLink() writes escapeHtml(content) into data-excerpt so the *attribute* is
// safe, but reading it back through `dataset` resolves the entities again, so
// what arrives here is the raw passage -- and the next line puts it into innerHTML.
// A PDF is untrusted input: without re-escaping, a passage containing
// <img src=x onerror=...> would be parsed into a live element in this drawer. The
// server's escapeHtml() cannot help with that, because decoding undoes it.
//
// So the passage and the clause are both escaped here, and the search runs on the
// escaped forms -- the same thing citationPanel() does on the server. That is what
// makes esc() and escapeHtml() load-bearing: they have to replace the same five
// characters the same way, or the drawer and the inline panel would mark different
// spans for one citation and the same quote would look different in the two places.
// test/citations.test.js runs this function against citationPanel() so they cannot
// drift, and covers the injection case.
//
// A clause that is absent gets no highlight, which is the same outcome the server
// produces. Same rule as citationPanel(): the *first* occurrence only.
function markClause(excerpt, clause) {
    const text = String(excerpt == null ? '' : excerpt).trim();
    if (!text) return '';
    const body = esc(text);
    const needle = clause ? esc(String(clause).trim()) : '';
    if (!needle) return body;
    const at = body.indexOf(needle);
    if (at < 0) return body;
    return body.slice(0, at) + '<mark>' + body.slice(at, at + needle.length) + '</mark>' + body.slice(at + needle.length);
}

function openCite(link) {
    const d = link.dataset;
    citeTitle.textContent = d.title || d.doc;
    citeMeta.textContent = (d.clause ? 'cl. ' + d.clause + ' · ' : '') + 'p. ' + d.page;
    citeExcerpt.innerHTML = markClause(d.excerpt || '', d.clause || '');
    citeNewTab.href = link.href;

    // Assigned per open rather than kept, so the previous document is unloaded
    // when a different citation is chosen.
    const want = '/api/documents/' + encodeURIComponent(d.doc) + '/pdf#page=' + encodeURIComponent(d.page);
    if (citeFrame.getAttribute('src') !== want) citeFrame.setAttribute('src', want);

    if (!citeViewer.classList.contains('open')) {
        citeReturnFocus = link;
        citeViewer.classList.add('open');
        citeViewer.setAttribute('aria-hidden', 'false');
        // inert while off screen would hide it from the tab order, but the panel is
        // visible during the transition, so it is removed once open and set on close.
        citeViewer.removeAttribute('inert');
        // Background first, then focus. The link that opened this lives inside
        // .wrap, so the browser blurs it as it goes inert; moving focus on the
        // same tick leaves no frame in which focus is nowhere.
        citeBackground.forEach((el) => el.setAttribute('inert', ''));
        citeViewer.querySelector('.cite-viewer-x').focus();
    }
}

function closeCite() {
    if (!citeViewer.classList.contains('open')) return;
    citeViewer.classList.remove('open');
    citeViewer.setAttribute('aria-hidden', 'true');
    citeViewer.setAttribute('inert', '');
    // Cleared so a 7.5 MB PDF is released instead of being held for the session.
    citeFrame.removeAttribute('src');
    // Lifted before the focus restore, not after: the element we are about to
    // return focus to is a citation link inside .wrap, and focusing a descendant
    // of an inert subtree silently does nothing.
    citeBackground.forEach((el) => el.removeAttribute('inert'));
    if (citeReturnFocus) {
        citeReturnFocus.focus();
        citeReturnFocus = null;
    }
}

// One delegated handler covers the answer, the near-match reply and the located
// reply, because .cite-link is rendered into all three by the server.
chatBox.addEventListener('click', (e) => {
    const link = e.target.closest('a.cite-link[data-doc]');
    if (!link) return;
    // Modified clicks are left alone so middle-click and ctrl-click still open a
    // new tab, which is the behaviour a plain link is expected to have.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openCite(link);
});

document.getElementById('citeViewer').addEventListener('click', (e) => {
    if (e.target.closest('[data-cite-close]')) closeCite();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCite();
    // Both surfaces, not just the viewer. Escape is the only keyboard route out of
    // an overlay, and a drawer left open behind a closed viewer is a panel sitting
    // over the page with the scrim still up.
    if (e.key === 'Escape' && sideOpen) closeSidebar();
});

/* ---------- transcript ---------- */

function emptyState() {
    chatBox.innerHTML = '<div class="turn"><div class="intro">' + esc(t('emptyState')) + '</div></div>';
}

/* The transcript has no height constraint of its own, so the *document* scrolls
   and `main` cannot be scrolled programmatically. Two consequences, both of which
   used to be bugs: assigning chatBox.scrollTop did nothing, and an appended turn
   only reached the viewport because turn() called scrollIntoView. */
const NEAR_BOTTOM_PX = 80;

function readerAtBottom() {
    // Measured against the document, not chatBox, for the reason above.
    if (typeof document === 'undefined' || typeof window === 'undefined') return true;
    const gap = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
    return gap <= NEAR_BOTTOM_PX;
}

function scrollToEnd() {
    // Instant, not smooth. This file removes motion rather than adding it, and a
    // jump that follows your eye is less disorienting than an eased one that
    // arrives after you have started reading.
    chatBox.scrollIntoView({ block: 'end' });
}

function turn(queryHtml, answerHtml, tagKey, meta) {
    // Sampled before the append, because appending changes the document height
    // and would therefore make the measurement meaningless.
    const stick = readerAtBottom();
    const div = document.createElement('div');
    div.className = 'turn';
    const tag = tagKey ? '<span class="tag">' + esc(t(tagKey)) + '</span>' : '';
    const metaLine = meta
        ? '<div class="side-note" style="margin-top:8px">' +
          esc(fill('metaLine', { ms: meta.ms, score: meta.score })) + '</div>'
        : '';
    // The server sanitises everything it renders and the only markup in `answerHtml`
    // is the server's own, so it is injected as-is. The query is escaped here
    // because it is echoed straight back from what the user typed.
    div.innerHTML =
        '<div class="q">' + queryHtml + tag + '</div>' +
        '<div class="a">' + answerHtml + '</div>' +
        metaLine;
    chatBox.appendChild(div);
    // Only if the reader was already at the bottom. The workflow this UI exists
    // for is scroll up, open a citation, check the clause against the passage --
    // so an answer arriving must never drag the viewport off what is being read.
    if (stick) scrollToEnd();
    return div;
}

function notice(html) {
    const d = document.createElement('div');
    d.className = 'notice';
    d.innerHTML = html;
    chatBox.appendChild(d);
    // Unconditionally, unlike a turn. This is a failure, and a failure that
    // renders quietly below the fold is worse than no notice at all: it looks
    // like the question simply went unanswered.
    scrollToEnd();
    return d;
}

/* The request currently in flight, so that it can be cancelled. The send button
   used to be disabled for the whole of a generation with no way out, which on a
   local model that takes tens of seconds is a dead end with a spinner. */
let inflight = null;

/* The button is two buttons depending on the state, so its label is set from the
   i18n table rather than baked into the markup. It is also re-set in the finally
   block below, because applyLanguage() rewrites every data-i18n element when the
   server answers in another language, and the label has to agree with whatever
   language the interface ended up in. */
function setSendLabel(key) {
    sendBtn.textContent = t(key);
}

function stopAsk() {
    if (inflight) inflight.abort();
}

function onSendClick() {
    if (inflight) stopAsk();
    else send();
}

async function send() {
    const text = input.value.trim();
    if (!text) return;
    // Enter during a generation must not start a second request. Cancelling is the
    // button's job, which is why the button is not disabled any more.
    if (inflight) return;

    input.value = '';
    resizeInput();
    setSendLabel('stopButton');
    const controller = new AbortController();
    inflight = controller;
    if (!chatBox.querySelector('.turn')) emptyState();
    const pending = turn(esc(text), '<div class="thinking">' + esc(t('thinking')) + '</div>', null, null);

    try {
        const res = await fetch(API_BASE + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 'auto', not `lang`. The server reads the script of the text itself, so
            // a Hindi question is translated and answered in Hindi whatever this
            // client last displayed. Sending the current UI language instead is what
            // made a Hindi question sent against the default `lang: 'en'` skip
            // translation altogether.
            body: JSON.stringify({ query: text, lang: 'auto' }),
            signal: controller.signal,
        });
        const data = await res.json();

        if (!res.ok) {
            pending.remove();
            notice(esc(data.error || t('serverError')));
            return;
        }

        const m = data.meta || {};

        // Follow the language actually used. The server answers in the script of the
        // question, so the interface should agree with the reply it just rendered —
        // otherwise a Hindi answer arrives wrapped in an English panel. Guarded on
        // difference so the common case (same language) touches no DOM.
        if (m.lang && m.lang !== lang) applyLanguage(m.lang);

        // Four genuinely different outcomes, previously all rendered as the same
        // plain bubble: the user could not tell a refusal from an outage.
        let tag = 'tagAnswer';
        if (m.degraded) tag = 'tagUnavailable';
        else if (m.band === 'located') tag = 'tagLocated';
        else if (m.band === 'bridge') tag = 'tagNearMiss';
        else if (m.band === 'miss' || m.notFound) tag = 'tagNotFound';

        const meta =
            m.total !== undefined
                ? { ms: m.total, score: m.topSimilarity !== undefined ? m.topSimilarity : '—' }
                : null;

        pending.remove();
        turn(esc(text), data.answer, tag, meta);
    } catch (err) {
        pending.remove();
        if (err && err.name === 'AbortError') {
            // The reader asked for this, so nothing is reported as wrong. The typed
            // question goes back in the composer rather than being dropped: they
            // cancelled the wait, not the question.
            input.value = text;
            resizeInput();
        } else {
            notice(esc(t('connError')));
        }
    } finally {
        inflight = null;
        setSendLabel('askButton');
        input.focus();
    }
}

function ask(text) {
    input.value = text;
    resizeInput();
    send();
}

function clearChat() {
    // Cancelled first, or the in-flight answer arrives into a transcript that has
    // just been emptied and appends itself to the empty state.
    stopAsk();
    emptyState();
    input.focus();
}

/* ---------- sidebar ---------- */

async function loadTopics() {
    const list = document.getElementById('topicList');
    const note = document.getElementById('topicNote');
    try {
        const res = await fetch(API_BASE + '/api/topics');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
          list.innerHTML = data.topics
              .map((x) =>
                  '<li><button class="side-btn" data-ask="' +
                  esc('What does clause ' + x.title + ' of ' + x.docTitle + ' say?') +
                  '">clause ' + esc(x.title) + ' <span class="code">' + esc(x.docTitle) + '</span></button></li>')
              .join('');
        note.textContent = t('topicsNote');
    } catch (err) {
        list.innerHTML = '';
        note.textContent = t('topicsError');
    }
}

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 3;
let searchTimer = null;
let searchSeq = 0;

function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

function dirNote(text) {
    document.getElementById('searchResults').innerHTML =
        '<div class="side-note">' + esc(text) + '</div>';
}

/* The card used to be a div with a click handler, which made the passage search
   reachable by mouse only -- and that search is the main way to find a passage.
   It is a button now, so it is focusable, reachable with Enter and Space, and
   announced as a control. The delegated handler matches on .dir-card, so the
   click path itself needed no change.

   The trailing ellipsis used to be appended unconditionally, so a 40-character
   preview ended in a "…" that claimed a truncation that had not happened, and the
   fixed 150-character slice could land inside a word -- or, in the Devanagari and
   Telugu this app is actually used in, inside a grapheme cluster, leaving a broken
   glyph. Both are handled by cutting back to the last space. */
function trimPreview(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const space = cut.lastIndexOf(' ');
    // The floor stops a long unbreakable token (a URL, a chemical string) from
    // collapsing the card to a single word.
    return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/\s+$/, '') + '…';
}

async function runSearch() {
    const q = document.getElementById('stdSearch').value.trim();
    const seq = ++searchSeq;
    const box = document.getElementById('searchResults');

    if (q.length < SEARCH_MIN_CHARS) {
        dirNote(t('directoryHint'));
        return;
    }

    dirNote(t('directorySearching'));
    try {
        const res = await fetch(API_BASE + '/api/search?q=' + encodeURIComponent(q) + '&k=8');
        const data = await res.json();
        if (seq !== searchSeq) return;
        if (!res.ok) throw new Error(data.error);
        if (!data.results.length) {
            dirNote(t('noResults'));
            return;
        }
        box.innerHTML = data.results
            .map((r) => {
                const pages = r.pages.length > 1 ? r.pages[0] + '–' + r.pages[1] : r.pages[0];
                const ask =
                    r.clause ? 'Tell me about ' + r.docTitle + ', clause ' + r.clause
                             : 'Tell me about ' + r.docTitle;
                return '<button type="button" class="dir-card" data-ask="' + esc(ask) + '">' +
                    '<span class="t">' + esc(r.docTitle) + '</span>' +
                    '<span class="m">' + esc('cl. ' + (r.clause || '—') + ' · p. ' + pages) + '</span>' +
                    '<span class="p">' + esc(trimPreview(r.preview, 150)) + '</span></button>';
            })
            .join('');
    } catch (err) {
        if (seq !== searchSeq) return;
        dirNote(t('directoryError'));
    }
}

/* ---------- header ---------- */

async function loadHealth() {
    const el = document.getElementById('runtimeLine');
    try {
        const res = await fetch(API_BASE + '/api/health');
        const d = await res.json();
        const c = d.config || {};
        // The active provider/model pair, read from the same config the server
        // runs on. It previously reported Gemini models on a fully local install,
        // which made it impossible to tell from the UI what was actually running.
        if (c.embedModel && c.genModel) {
            el.textContent = fill('runtimeLine', {
                embed: c.embedProvider + '/' + c.embedModel,
                gen: c.genProvider + '/' + c.genModel,
            });
        } else {
            el.textContent = t('runtimeUnknown');
        }

        if (d.corpus) {
            const pages = (d.corpus.documents || []).reduce((n, x) => n + (x.pageCount || 0), 0);
            const titles = (d.corpus.documents || []).map((x) => x.docTitle);
            const line = document.getElementById('corpusLine');
            // Counts, not the whole title list. This line used to join every
            // document title in the corpus with ", ", so the height of the header
            // was a function of how much had been ingested: four rows on a desktop
            // and eight on a phone, from the five PDFs in data/pdfs. The titles
            // are still one hover away, which is all they were ever for -- the line
            // identifies the corpus, and the sidebar lists the same set anyway.
            line.textContent = fill('corpusLine', {
                docs: titles.length,
                pages,
                chunks: d.corpus.chunkCount,
            });
            line.title = titles.join(' · ');
        }
    } catch (err) {
        el.textContent = t('connError');
    }
}

/**
 * Swap the interface language.
 *
 * This used to be `setLanguage(next)` and was only ever called by the language
 * <select>, which meant the interface spoke your language only if you went looking
 * for the dropdown first. There is no dropdown now: the server detects the script
 * of the question, answers in it, and returns it in `meta.lang`, and this is
 * called from the response handler when that differs from what is on screen.
 *
 * The `loadTopics`/`loadHealth` calls that used to be in here are gone. They
 * existed only to re-label the sidebar after a manual switch, and they were the
 * reason `test/directory.test.js` had to assert that changing language does not
 * spend an embedding call. Topics are data rather than labels, so relabelling
 * cannot invalidate them and nothing needs re-fetching.
 */
function applyLanguage(next) {
    lang = LANGS.includes(next) ? next : 'en';
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const v = I18N[lang][el.getAttribute('data-i18n')];
        if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        const v = I18N[lang][el.getAttribute('data-i18n-placeholder')];
        if (v) el.placeholder = v;
    });
    // data-i18n only sets textContent, so attributes need their own pass. Used by
    // the source viewer's close button, whose accessible name must translate too.
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
        const v = I18N[lang][el.getAttribute('data-i18n-aria')];
        if (v) el.setAttribute('aria-label', v);
    });
    document.getElementById('topicNote').textContent = t('topicsNote');
    document.getElementById('stdSearch').placeholder = t('searchPlaceholder');
    // The theme button's label contains a mode name, so it cannot go through the
    // data-i18n pass above and has to be repainted here, like the two id-based lines
    // next to it.
    paintTheme();
    // Relabelling the search box invalidates whatever it was showing.
    if (!document.getElementById('stdSearch').value.trim()) dirNote(t('directoryHint'));
    input.focus();
}

// First paint. Topics and health are loaded here rather than from inside
// applyLanguage: they were only ever fetched from there to relabel the sidebar
// after a manual language switch, and with detection driving the language there is
// no manual switch to relabel for. Fetching once, here, is also what stops the
// startup doubling where these ran twice on first paint.
// The theme is read first because applyLanguage paints the button's label, and
// that label names the mode.
themeMode = readStoredTheme();
applyLanguage('en');
loadTopics();
loadHealth();
emptyState();
