import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UI_DIR = new URL('../public/', import.meta.url);
const htmlRaw = readFileSync(new URL('index.html', UI_DIR), 'utf8');
const cssRaw = readFileSync(new URL('app.css', UI_DIR), 'utf8');
const jsRaw = readFileSync(new URL('app.js', UI_DIR), 'utf8');

/**
 * The page with its comments stripped.
 *
 * Needed, because several things these tests assert about are also *described* in
 * prose: the removed-list block names chatBox.scrollTop, and the comment above the
 * scroll guard explains that chatBox.scrollTop never worked. Matching the raw file
 * would let that documentation satisfy an assertion about the code -- or break one,
 * depending only on how carefully the note was worded.
 */
const strip = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const html = strip(htmlRaw);
const src = strip(jsRaw);
const css = strip(cssRaw);

/** WCAG relative luminance. */
function luminance(hex) {
    // 3-digit shorthand is expanded first, because "#777" is "#777777" and not
    // "#000777". Reading the shorthand literally splits it into the wrong channels
    // and lands on a saturated colour with a huge ratio, which turns the threshold
    // below into decoration. Both #777 and #555 are shorthand, so this was not
    // hypothetical: the ink-faint assertion passed while the token was the exact
    // value that change was made to replace.
    const h = hex.length === 4
        ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
        : hex;
    const n = parseInt(h.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
}

/** Slice a top-level function out of the page script, braces and all. */
function fnBody(name) {
    const start = src.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, `${name}() is missing from the page script`);
    const end = src.indexOf('\n}', start);
    assert.notEqual(end, -1, `${name}() has no closing brace`);
    return src.slice(start, end);
}

const LIGHT_ROOT = css.match(/^\s*:root\s*\{([^}]*)\}/m);
const DARK_ROOT = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/);

/** The two palettes the theme button can force, which the button's own rules key off. */
const FORCED_ROOT = {
    light: css.match(/:root\[data-theme=['"]light['"]\]\s*\{([^}]*)\}/),
    dark: css.match(/:root\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/),
};

/**
 * The body of a block whose opening brace is the character before `from`.
 *
 * Needed because `@media (max-width: 860px)` appears in more than one block now --
 * the citation viewer's and the layout's -- so an assertion about "what happens on
 * a phone" has to see all of them rather than whichever came first. A lazy
 * `[\s\S]*?\}` would stop at the first nested rule and silently check a fragment.
 */
function blockBody(from) {
    let depth = 1;
    for (let i = from; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) return css.slice(from, i);
    }
    return '';
}

/** Every `max-width: 860px` block in the stylesheet, joined. */
const MOBILE = [...css.matchAll(/@media\s*\(max-width:\s*860px\)\s*\{/g)]
    .map((m) => blockBody(m.index + m[0].length))
    .join('\n');

/** Selector lists of every rule, grouped as the stylesheet grouped them. */
const SELECTOR_LISTS = [...css.matchAll(/(^|[{}])\s*([^{}@]+?)\s*\{/g)].map((m) => m[2].trim());

/** Read a palette out of one `:root` block body and resolve tokens from it alone. */
function blockTokens(block) {
    const tokens = new Map();
    for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        tokens.set(name, value.trim());
    }
    return (name) => {
        const v = tokens.get(name);
        assert.ok(v, `--${name} is not defined in this block`);
        return v;
    };
}

/** Resolve a token as the browser would for the requested scheme. */
function schemeTokens(which) {
    assert.ok(LIGHT_ROOT, 'there is no top-level :root block');
    const tokens = new Map();
    const read = (block) => {
        for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
            tokens.set(name, value.trim());
        }
    };
    read(LIGHT_ROOT[1]);
    if (which === 'dark') {
        assert.ok(DARK_ROOT, 'there is no prefers-color-scheme: dark :root block');
        read(DARK_ROOT[1]);
    }
    return (name) => {
        const v = tokens.get(name);
        assert.ok(v, `--${name} is not defined for the ${which} scheme`);
        return v;
    };
}

/**
 * The pairs that have to clear the AA floor, by token name.
 *
 * Names rather than values, so one list can be run against every palette in the
 * file -- the two that follow the system, and the two the button can force --
 * instead of being written out four times and drifting apart.
 */
const AA_PAIRS = [
      ['ink', 'page'],
      ['ink-soft', 'page'],
      // The question bubble. A new surface has to be measured like any other: the
      // bubble is --bubble, and --ink on it is the reading of the user's own
      // question, which is the one line of the transcript guaranteed to be there.
      ['ink', 'bubble'],
    // 4.48:1 before the fix, and it carries the 11px sidebar labels, the language
    // tag, the citation toggle and every page number.
    ['ink-faint', 'page'],
    ['ink-faint', 'panel'],
    ['ink-soft', 'panel'],
    ['link', 'page'],
    // The one place colour carries meaning, and the clause highlight.
    ['warn', 'warn-bg'],
    ['mark-ink', 'mark-bg'],
];

/** Assert every AA pair holds, for a token resolver, under a label for the message. */
function assertAA(label, token) {
    for (const [fg, bg] of AA_PAIRS) {
        const fgHex = token('--' + fg);
        const bgHex = token('--' + bg);
        const ratio = contrast(fgHex, bgHex);
        assert.ok(
            ratio >= 4.5,
            `${label}: --${fg} on --${bg} (${fgHex} on ${bgHex}) is ${ratio.toFixed(2)}:1, under the 4.5:1 AA floor`
        );
    }
}

test('every text colour clears the 4.5:1 AA floor in the dark scheme too', () => {
    // The same list, run twice. The point of the dark block is that it cannot be
    // edited without being measured: the light-scheme values sit at roughly 8:1
    // against white and would fall to about 2:1 against a dark ground, so a token
    // copied over unchanged would pass every other test in this file.
    for (const which of ['light', 'dark']) assertAA(which, schemeTokens(which));
});

test('forcing a theme with the button measures as well as following the system', () => {
    // :root[data-theme] restates both palettes, so it is twice the chance to write a
    // colour that passes review and fails contrast. These two blocks are not read by
    // the test above, and nothing in the browser would object to a bad value here --
    // the only thing that catches it is this.
    for (const which of ['light', 'dark']) {
        const block = FORCED_ROOT[which];
        assert.ok(block, `there is no :root[data-theme='${which}'] block, so the button cannot force that scheme`);
        assertAA(`forced ${which}`, blockTokens(block[1]));
    }
});

test('a forced theme restates the palette instead of quietly drifting from it', () => {
    // The duplication is what lets an explicit choice beat prefers-color-scheme, and
    // it is the one thing in this file that can be edited in two places by accident.
    // A colour fixed in the base palette and forgotten here renders stale the moment
    // the button is pressed, in a mode the reviewer did not look at. So the forced
    // blocks are diffed against the originals: same token names, same values.
    const names = (block) => [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort();
    assert.ok(LIGHT_ROOT, 'there is no top-level :root block');
    for (const which of ['light', 'dark']) {
        const block = FORCED_ROOT[which];
        assert.ok(block, `there is no :root[data-theme='${which}'] block`);
        assert.deepEqual(
            names(block[1]),
            names(LIGHT_ROOT[1]),
            `the forced ${which} palette declares a different set of tokens than the base one`
        );
    }
    assert.ok(DARK_ROOT, 'there is no prefers-color-scheme: dark :root block');
    for (const [forced, canonical, label] of [
        [FORCED_ROOT.light, LIGHT_ROOT, 'light'],
        [FORCED_ROOT.dark, DARK_ROOT, 'dark'],
    ]) {
        const a = blockTokens(forced[1]);
        const b = schemeTokens(label);
        for (const name of names(canonical[1])) {
            assert.equal(a(name), b(name), `--${name} differs between the ${label} palette and the forced ${label} one`);
        }
    }
});

test('every colour in the stylesheet is a token, so a second scheme stays possible', () => {
    // The hardcoded literals are what actually break dark mode. A #fff left in a
    // rule is invisible in review and glaring at night, and it is how the five
    // surfaces in this file nearly were.
    //
    // `:root` optionally qualified by an attribute, because the forced themes are
    // declared as :root[data-theme='dark'] and are token blocks by exactly the same
    // reasoning: a palette is not a place for a literal that no test can see.
    const ROOT_BLOCK = /:root(?:\[[^\]]*\])?\s*\{[^}]*\}/g;
    const rootBlocks = [...css.matchAll(ROOT_BLOCK)].map((m) => m[0]).join('\n');
    const declared = new Set([...rootBlocks.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]));
    const body = css.replace(ROOT_BLOCK, '');
    const stray = [...new Set([...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]))];

    assert.deepEqual(stray, [], `hardcoded colour(s) outside the token blocks: ${stray.join(', ')}`);
    assert.ok(declared.size >= 20, `only ${declared.size} token values are declared`);
});

test('the clause highlight pins its own text colour instead of inheriting it', () => {
    // `color: inherit` on the highlight is invisible in the light scheme, where the
    // fill is pale and the inherited text is dark. The moment the page inverts, the
    // same rule is light text on a light fill.
    const marks = [...css.matchAll(/mark\s*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(marks.length >= 2, 'the highlight should be styled in both the inline and drawer excerpts');
    for (const body of marks) {
        assert.match(body, /color:\s*var\(--mark-ink\)/, 'a highlight rule inherits its text colour');
        assert.doesNotMatch(body, /color:\s*inherit/);
    }
});

test('the transcript has a readable measure, and it covers the whole turn', () => {
    // Uncapped it ran the full width of the window: around 1600px of line on a wide
    // monitor. On .turn rather than .a, so the question, the answer and the timing
    // line share one measure instead of the question spanning the window while the
    // answer sat in a narrow column.
    const rule = css.match(/\.turn\s*\{([^}]*)\}/);
    assert.ok(rule, 'the .turn rule is missing');
    const cap = rule[1].match(/max-width:\s*(\d+(?:\.\d+)?)ch/);
    assert.ok(cap, '.turn has no ch-based max-width, so the measure is uncapped');
    const ch = Number(cap[1]);
    assert.ok(ch >= 55 && ch <= 80, `a ${ch}ch measure is outside the 55-80ch readable band`);

    // Long document titles forced the transcript to scroll sideways on a phone.
    assert.match(css, /\.src\s*\{[^}]*overflow-wrap:\s*anywhere/, '.src does not wrap long titles');
});

test('an arriving answer does not drag the viewport off what is being read', () => {
    const turn = fnBody('turn');
    // Sampled before the append, or the append invalidates the measurement.
    assert.match(turn, /readerAtBottom\(\)/, 'turn() does not check where the reader is');
    assert.match(turn, /if \(stick\) scrollToEnd\(\)/, 'turn() scrolls unconditionally');

    const guard = fnBody('readerAtBottom');
    // The document scrolls; main has no height of its own. Measuring chatBox is
    // the mistake this replaced.
    assert.match(guard, /documentElement\.scrollHeight/, 'the guard measures the wrong scroller');
    assert.match(guard, /window\.innerHeight/, 'the guard ignores the viewport height');

    // A threshold large enough to always be true silently disables the guard.
    const px = Number(src.match(/NEAR_BOTTOM_PX\s*=\s*(\d+)/)[1]);
    assert.ok(px > 0 && px <= 200, `NEAR_BOTTOM_PX of ${px}px makes the guard inert`);
});

test('a failure notice always reaches the viewport', () => {
    const notice = fnBody('notice');
    assert.match(notice, /scrollToEnd\(\)/, 'notice() does not scroll itself into view');
    // Deliberately the opposite policy to turn(): an answer you scrolled away from
    // can wait, but a failure that renders below the fold reads as no answer at all.
    assert.doesNotMatch(notice, /stick/, 'notice() inherited the conditional scroll guard');
});

test('a generation can be cancelled, and cancelling is not reported as a failure', () => {
    const send = fnBody('send');
    assert.match(send, /new AbortController\(\)/, 'the request cannot be cancelled');
    assert.match(send, /signal: controller\.signal/, 'the abort signal is never passed to fetch');
    // Enter during a generation used to be blocked by disabling the button, which
    // cannot be the same button that cancels. Now the guard is explicit.
    assert.match(send, /if \(inflight\) return;/, 'Enter during a generation starts a second request');
    assert.match(
        send,
        /err\.name === 'AbortError'/,
        'an abort is indistinguishable from a network failure, so cancelling shows an error'
    );
    assert.match(send, /input\.value = text;/, 'the typed question is discarded when cancelled');
    assert.match(send, /setSendLabel\('askButton'\)/, 'the button label is never restored');
    // A disabled button cannot also be the cancel control.
    assert.doesNotMatch(send, /sendBtn\.disabled = true/, 'the button is disabled for the whole generation');

    // Clearing mid-generation used to empty the transcript and then let the answer
    // append itself to the empty state.
    assert.match(fnBody('clearChat'), /stopAsk\(\)/, 'clearChat leaves the request running');
    assert.match(html, /id="sendBtn"[^>]*onclick="onSendClick\(\)"/, 'the send button is not wired to the dispatcher');
});

test('passage search results are reachable by keyboard', () => {
    const run = fnBody('runSearch');
    // These results are the main way to reach a passage. A div with a click handler
    // is invisible to the keyboard and announced as nothing at all.
    assert.match(run, /<button type="button" class="dir-card"/, 'the result card is not a button');
    assert.doesNotMatch(run, /<div class="dir-card"/, 'the result card is still a div with a click handler');
});

test('a preview only claims to be truncated when it was', () => {
    const trim = fnBody('trimPreview');
    assert.match(trim, /if \(s\.length <= max\) return s;/, 'the ellipsis is appended even when nothing was cut');
    // The cut also used to land mid-word, and inside a grapheme cluster in the
    // Devanagari and Telugu this app is used in.
    assert.match(trim, /lastIndexOf\(' '\)/, 'the cut is not moved back to a word boundary');
});

test('the dead empty-state list rules have not come back', () => {
    assert.doesNotMatch(css, /\.intro\s+(ul|li)\b/, 'the .intro list rules are unused: emptyState is one sentence');
});

test('the scroll assignments that could never do anything have not come back', () => {
    // chatBox.scrollTop was assigned in three places and was a no-op in all of
    // them. It is the kind of line that gets restored by muscle memory.
    assert.doesNotMatch(src, /chatBox\.scrollTop/);
});

/* ------------------------------------------------------------------ *
 * The layout shell: the reading column, the sidebar, and the drawer the
 * sidebar becomes on a phone.
 * ------------------------------------------------------------------ */

test('the header cannot be driven by the size of the corpus', () => {
    // This line used to carry every document title in the corpus, joined with
    // ", ", so the height of the header was a function of how much had been
    // ingested: four rows on a desktop and eight on a phone, from the five PDFs
    // in data/pdfs. A header that grows pushes the whole transcript down the page,
    // and it grows on the reader's device rather than on the author's.
    const health = fnBody('loadHealth');
    assert.match(health, /docs:\s*titles\.length/, 'the corpus line is not counting documents');
    assert.doesNotMatch(health, /join\(', '\)/, 'the corpus line is listing every title again');
    // The titles are moved, not dropped: they are one hover away, which is all
    // they were ever for.
    assert.match(health, /line\.title = titles\.join/, 'the full title list is no longer reachable');

    // And the clamp, so a single long unbroken title cannot grow the header either.
    const sub = css.match(/header \.sub\s*\{([^}]*)\}/);
    assert.ok(sub, 'the header sub-line rule is missing');
    assert.match(sub[1], /white-space:\s*nowrap/, 'the sub-line wraps instead of truncating');
    assert.match(sub[1], /text-overflow:\s*ellipsis/);
});

test('the composer shares the reading column: same measure, same axis', () => {
    const turn = css.match(/\.turn\s*\{([^}]*)\}/)[1];
    // Read off the turn rather than hardcoded, so the two cannot drift apart
    // without this failing: uncapped, the input ran the full width of the window
    // and put the Ask button out in the dead space to the right of the answer.
    const measure = turn.match(/max-width:\s*(\d+)ch/)[1];
    assert.match(turn, /margin-inline:\s*auto/, 'the reading column is not centred');

    const inner = css.match(/\.composer \.inner\s*\{([^}]*)\}/);
    assert.ok(inner, 'the composer inner rule is missing');
    assert.match(inner[1], new RegExp(`max-width:\\s*${measure}ch`), 'the composer is not capped to the reading measure');
    assert.match(inner[1], /margin-inline:\s*auto/, 'the composer is not centred on the same axis');

    // A notice is a turn's peer. Uncapped it was a shrink-to-fit box floating in
    // the middle of a wide column, which reads as a stray element rather than as
    // a failure of the turn above it.
    const notice = css.match(/\.notice\s*\{([^}]*)\}/)[1];
    assert.match(notice, new RegExp(`max-width:\\s*${measure}ch`), 'a failure notice is not the width of a turn');
    assert.match(notice, /margin-inline:\s*auto/);
});

test('neither sidebar region can push the other controls off the panel', () => {
    // The topic list holds up to suggestionCount x 3 entries from /api/topics and
    // a search returns 8 cards. Both used to share one 100vh scroller, with the
    // search box above them and Clear transcript below, so on a short window the
    // two controls lost: the search box is the main route to a passage, and Clear
    // transcript was somewhere under a list of eighteen.
    for (const sel of ['#searchResults', '#topicList']) {
        const rule = css.match(new RegExp(sel + '\\s*\\{([^}]*)\\}'));
        assert.ok(rule, `${sel} has no rule of its own`);
        assert.match(rule[1], /overflow-y:\s*auto/, `${sel} cannot scroll itself`);
        // In vh, so each region is a share of whatever window there is. The aside
        // keeps its own max-height as the backstop for the case where they add up.
        assert.match(rule[1], /max-height:\s*\d+vh/, `${sel} has no cap in viewport units`);
    }

    const aside = html.match(/<aside[^>]*id="sidePanel"[\s\S]*?<\/aside>/);
    assert.ok(aside, 'the sidebar markup is missing');
    const at = (needle) => aside[0].indexOf(needle);
    assert.ok(at('id="stdSearch"') < at('id="topicList"'), 'the topic list is back above the search box');
    assert.ok(at('id="topicList"') < at('onclick="clearChat()"'), 'Clear transcript is back above the list it acts on');
});

test('the sidebar exists on a phone, as a drawer rather than as nothing', () => {
    // `display: none` below 860px made passage search and the topic list absent on
    // the device a standards answer is most likely read on. Both are the only
    // route to a passage that the answer does not happen to cite.
    assert.doesNotMatch(MOBILE, /aside\s*\{[^}]*display:\s*none/, 'the sidebar is hidden on narrow viewports');

    // A drawer needs a way in, and a scrim and a close button are not it.
    assert.match(html, /id="sideToggle"[^>]*onclick="toggleSidebar\(\)"/, 'the drawer has no trigger');
    assert.match(html, /id="sideToggle"[\s\S]*?aria-expanded="false"/, 'the trigger does not report its state');
    assert.match(html, /aria-controls="sidePanel"/, 'the trigger does not name what it controls');
    assert.match(html, /id="sidePanel"/, 'the drawer has no element to be');

    // All three pieces of chrome hidden above 860px, where the sidebar is already
    // a column and a trigger would be a control that does nothing. Matched on the
    // grouped selector list so reordering the group is not a failure.
    const group = SELECTOR_LISTS.find((s) =>
        ['.side-toggle', '.side-top', '.side-scrim'].every((c) => s.includes(c)));
    assert.ok(group, 'the drawer chrome is not hidden as a group above 860px');
    assert.match(css, new RegExp(group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{\\s*display:\\s*none;'));
    assert.match(MOBILE, /\.side-toggle\s*\{\s*display:\s*inline-flex/, 'the trigger is not shown at narrow widths');

    // Labelled in all four languages. i18n.test.js checks the tables agree; this
    // checks the keys reached the markup, which is the half that table test cannot see.
    for (const key of ['openIndex', 'closeIndex']) {
        assert.match(html, new RegExp(`data-i18n(?:-aria)?="${key}"`), `${key} is in the tables but not in the markup`);
    }
});

test('the drawer can always be dismissed', () => {
    // A panel that can only be closed by reloading is a trap on a touch device,
    // where Escape does not exist and a scrim is not obviously a control. Same
    // three routes the citation viewer is held to in citations.test.js.
    assert.match(
        src,
        /sideScrim\.addEventListener\('click', closeSidebar\)/,
        'the scrim does not close the drawer'
    );
    assert.match(html, /class="side-x"[^>]*data-side-close/, 'there is no close control inside the drawer');

    // Escape reaches it too, and the assertion is on the handler rather than on
    // the string: the same keydown listener has to close both overlays, because
    // leaving a drawer open behind a closed viewer is a panel over the page.
    const keydown = src.match(/document\.addEventListener\('keydown',[\s\S]*?\n\}\);/);
    assert.ok(keydown, 'the page has no document keydown handler');
    assert.match(keydown[0], /e\.key === 'Escape'/);
    assert.match(keydown[0], /closeSidebar\(\)/, 'Escape does not close the drawer');
});

test('the drawer backgrounds the page without taking itself down with it', () => {
    // '.wrap' is the viewer's list and it is wrong here: the drawer is a child of
    // .wrap, so marking .wrap inert would make the drawer inert at the same
    // moment it opened, and the panel would be visible and dead.
    const list = src.match(/const sideBackground = \[([^\]]*)\]/);
    assert.ok(list, 'the drawer has no background list');
    assert.match(list[1], /'main'/, 'the transcript is not inert while the drawer is open');
    assert.doesNotMatch(list[1], /'\.wrap'/, 'the drawer is inside .wrap, so .wrap takes it down with the page');

    // Focus in, background inert first: the trigger is inside `header`, and the
    // browser blurs it as `header` goes inert, so focusing on the earlier tick
    // leaves a frame in which focus is nowhere.
    const open = fnBody('openSidebar');
    assert.ok(
        open.indexOf("setAttribute('inert'") < open.indexOf('.focus()'),
        'the drawer moves focus before the background is inert'
    );
    assert.match(open, /querySelector\('\.side-x'\)\.focus\(\)/, 'opening the drawer does not move focus into it');

    // And the reverse order on the way out, for the same reason: focusing a
    // descendant of an inert subtree silently does nothing.
    const close = fnBody('closeSidebar');
    assert.ok(
        close.indexOf("removeAttribute('inert')") < close.indexOf('sideToggle.focus()'),
        'focus is restored while the trigger is still inert, so it silently fails'
    );
});

test('the drawer closes itself when the viewport leaves the narrow range', () => {
    // Above 860px the drawer rules stop applying and the sidebar is a static
    // column again -- but the `inert` on the background is script, not CSS, so a
    // tablet rotating out of portrait would leave the whole app dead to clicks.
    const guard = src.match(/matchMedia\([\s\S]*?\n\}\);/);
    assert.ok(guard, 'the drawer does not watch the viewport width');
    assert.match(guard[0], /!e\.matches/, 'the drawer survives into the wide layout with the page inert behind it');
    assert.match(guard[0], /closeSidebar\(\)/);
});

test('the theme button cycles system, light and dark, and only the choice is an attribute', () => {
    // "System" is a mode rather than the absence of a control, because it is the
    // state every install starts in: a two-state toggle can be walked out of but
    // never back into, and anyone who wants their page to follow a system that
    // changes would be stuck on whichever scheme they happened to press last.
    const cycle = fnBody('cycleTheme');
    assert.match(
        cycle,
        /THEME_MODES\.indexOf\(themeMode\)\s*\+\s*1\)\s*%\s*THEME_MODES\.length/,
        'the button does not cycle through every mode'
    );
    assert.match(cycle, /paintTheme\(\)/, 'cycling does not repaint the button');
    assert.match(cycle, /localStorage\.setItem/, 'the choice is not remembered between visits');

    // The mode is carried by the attribute's *absence*, not by a value. That is what
    // leaves prefers-color-scheme in charge for everyone who has not chosen, including
    // before this script has run at all -- so "system" must remove, never set.
    const paint = fnBody('paintTheme');
    assert.match(
        paint,
        /themeMode === 'auto'[\s\S]*?removeAttribute\('data-theme'\)/,
        '"system" is set as a value instead of removed, so the media query is overridden even with no choice made'
    );
    assert.match(paint, /setAttribute\('data-theme',\s*themeMode\)/, 'an explicit choice does not reach the attribute the CSS keys off');

    // Specificity is the whole mechanism: :root is (0,1,0) and :root[data-theme] is
    // (0,2,0), so a choice wins without !important and without caring about order.
    assert.doesNotMatch(css, /!important/, 'the theme blocks lean on !important instead of specificity');
    assert.match(css, /:root\[data-theme=['"]dark['"]\]\s*\{\s*color-scheme:\s*only dark/, 'a forced dark theme does not pin color-scheme');
    assert.match(css, /:root\[data-theme=['"]light['"]\]\s*\{\s*color-scheme:\s*only light/, 'a forced light theme does not pin color-scheme');

    // In the header, not the sidebar: it has to be reachable without opening the
    // drawer, which on a phone is the only route into the sidebar.
    const header = html.match(/<header>[\s\S]*?<\/header>/);
    assert.ok(header, 'there is no <header>');
    assert.match(header[0], /id="themeBtn"/, 'the theme button is not in the header');
    assert.match(header[0], /onclick="cycleTheme\(\)"/, 'the theme button is not wired to the cycle');

    // The label names the mode, from the i18n tables, so it translates with the rest
    // of the interface -- and it cannot go through data-i18n, because that pass would
    // overwrite a label whose text depends on the mode. Scoped to the button's own tag:
    // searching the rest of the header would fire on any data-i18n element that happens
    // to sit after it.
    const tag = header[0].match(/<button[^>]*id="themeBtn"[^>]*>/);
    assert.ok(tag, 'the theme button is not a <button>');
    assert.doesNotMatch(tag[0], /data-i18n=/, 'the button should be repainted by paintTheme, not by the data-i18n pass');
    assert.match(paint, /fill\('themeLabel'/, 'the button label is not translated');
    assert.match(paint, /setAttribute\('aria-label'/, 'the theme button has no accessible name');
});
