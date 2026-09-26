import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineTitleFromContent, titleFromFilename } from '../src/pdf.js';

const page = (text) => [{ text }];
const pages = (...texts) => texts.map((t) => ({ text: t }));

test('an IS standard uses the designation printed on page 1', () => {
  const t = refineTitleFromContent('fallback', page('IS 14543:2024 Packaged Drinking Water'));
  assert.equal(t, 'IS 14543:2024');
});

test('a title page is found and title-cased', () => {
  // The shape of the real SP 21 front matter: the name is set as a run of
  // capital lines on a title page, not stated as an IS code anywhere.
  const t = refineTitleFromContent(
    'Is Sp 21 2005',
    pages(
      'Disclosure to Promote the Right To Information\nWhereas the Parliament of India has set out',
      'SUMMARIES OF INDIAN STANDARDS\nFOR\nBUILDING MATERIALS\n(First Revision)\nBUREAU OF INDIAN STANDARDS'
    )
  );
  assert.equal(t, 'SP 21 — Summaries of Indian Standards for Building Materials');
});

test('the SP designation is prefixed when the filename carries it', () => {
  const t = refineTitleFromContent(
    'Is Sp 7 2005',
    pages('MANUAL OF PRACTICES\nAND PROCEDURES', 'prose follows here')
  );
  assert.match(t, /^SP 7 — /);
  assert.match(t, /Manual of Practices and Procedures$/);
});

test('front-matter boilerplate is never mistaken for the title', () => {
  // The RTI notice is set in the same capitals as a title page, and picking it
  // would name every BIS document "Disclosure to Promote the Right To
  // Information".
  const t = refineTitleFromContent(
    'fallback',
    page(
      'Disclosure to Promote the Right To Information\nWhereas the Parliament of India has set out a regime\nBUREAU OF INDIAN STANDARDS\nMANAK BHAVAN\nFIRST PUBLISHED MARCH 1985'
    )
  );
  assert.equal(t, 'fallback');
});

test('a table of contents is not mistaken for the title', () => {
  // Category headings are interleaved with sentence-cased IS entries, which
  // break the run before it can look like a title.
  const t = refineTitleFromContent(
    'fallback',
    page(
      '1.1\nSECTION 1\nCEMENT AND CONCRETE\n\nAGGREGATES\n' +
        'IS 383 : 1970 Coarse and fine aggregates from natural sources (second revision) 1.5\n' +
        'CEMENT\nIS 1489 : Portland pozzolana cement'
    )
  );
  assert.equal(t, 'IS 383 : 1970');
});

test('short acronyms survive title-casing', () => {
  const t = refineTitleFromContent('fb', page('GUIDELINES\nBY\nBIS FOR\nCEMENT QUALITY'));
  assert.equal(t, 'BIS for Cement Quality');
});

test('no title block falls back to the filename-derived title', () => {
  assert.equal(refineTitleFromContent('IS 999:2020 Foo', page('just some prose, nothing in caps')), 'IS 999:2020 Foo');
  assert.equal(refineTitleFromContent('fb', []), 'fb');
});

test('filename titles are humanised', () => {
  assert.equal(titleFromFilename('is-14543-2024-packaged-drinking-water.pdf'), 'IS 14543:2024 Packaged Drinking Water');
  // BIS puts the part inside the designation, before the year.
  assert.equal(titleFromFilename('is16102-part-1-2012.pdf'), 'IS 16102 (Part 1):2012');
  assert.equal(titleFromFilename('is16102.pdf'), 'IS 16102');
});
