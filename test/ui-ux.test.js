import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UI_FILE = new URL('../BIS_Assistant_frontend.html', import.meta.url);
const html = readFileSync(UI_FILE, 'utf8');

/**
 * The page with its comments stripped.
 *
 * Needed, because several things these tests assert about are also *described* in
 * prose: the removed-list block names chatBox.scrollTop, and the comment above the
 * scroll guard explains that chatBox.scrollTop never worked. Matching the raw file
 * would let that documentation satisfy an assertion about the code -- or break one,
 * depending only on how carefully the note was worded.
 */
const src = html
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const css = src.match(/<style>([\s\S]*?)<\/style>/)[1];

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

test('every text colour clears the 4.5:1 AA floor in the dark scheme too', () => {
    // The same list, run twice. The point of the dark block is that it cannot be
    // edited without being measured: the light-scheme values sit at roughly 8:1
    // against white and would fall to about 2:1 against a dark ground, so a token
    // copied over unchanged would pass every other test in this file.
    for (const which of ['light', 'dark']) {
        const token = schemeTokens(which);
        const pairs = [
            ['ink', 'page', token('--ink'), token('--page')],
            ['ink-soft', 'page', token('--ink-soft'), token('--page')],
            // 4.48:1 before the fix, and it carries the 11px sidebar labels, the
            // language tag, the citation toggle and every page number.
            ['ink-faint', 'page', token('--ink-faint'), token('--page')],
            ['ink-faint', 'panel', token('--ink-faint'), token('--panel')],
            ['ink-soft', 'panel', token('--ink-soft'), token('--panel')],
            ['link', 'page', token('--link'), token('--page')],
            // The one place colour carries meaning, and the clause highlight.
            ['warn', 'warn-bg', token('--warn'), token('--warn-bg')],
            ['mark-ink', 'mark-bg', token('--mark-ink'), token('--mark-bg')],
        ];

        for (const [fg, bg, fgHex, bgHex] of pairs) {
            const ratio = contrast(fgHex, bgHex);
            assert.ok(
                ratio >= 4.5,
                `${which}: --${fg} on --${bg} (${fgHex} on ${bgHex}) is ${ratio.toFixed(2)}:1, under the 4.5:1 AA floor`
            );
        }
    }
});

test('every colour in the stylesheet is a token, so a second scheme stays possible', () => {
    // The hardcoded literals are what actually break dark mode. A #fff left in a
    // rule is invisible in review and glaring at night, and it is how the five
    // surfaces in this file nearly were.
    const rootBlocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    const declared = new Set([...rootBlocks.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]));
    const body = css.replace(/:root\s*\{[^}]*\}/g, '');
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
    assert.match(src, /id="sendBtn"[^>]*onclick="onSendClick\(\)"/, 'the send button is not wired to the dispatcher');
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
