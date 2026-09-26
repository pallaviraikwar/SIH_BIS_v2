import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkDocument, toEmbeddableText } from '../src/chunker.js';
import { titleFromFilename, stripRunningHeads } from '../src/pdf.js';
import { normaliseLang, looksNonLatin, langName } from '../src/translator.js';
import { escapeHtml, renderAnswerHtml, modelSaysNotFound } from '../src/render.js';
import { buildAnswerPrompt } from '../src/prompts.js';

const PAGES = [
  {
    pageNumber: 1,
    text: 'INDIAN STANDARD\nIS 14543 : 2024\nPACKAGED DRINKING WATER\n\n1 SCOPE\nThis standard specifies the quality requirements for packaged drinking water other than natural mineral water.\n\n2 REFERENCES\nIS 10500 (Part 1) : 1993, Drinking Water',
  },
  {
    pageNumber: 2,
    text: 'IS 14543 : 2024\n\n5 REQUIREMENTS\n5.1 Microbiological Requirements\nThe product shall be free from Escherichia coli in any 100 ml sample.\n\n5.2 Chemical Requirements\nTotal dissolved solids shall not exceed 2000 mg per litre.',
  },
];

test('titleFromFilename builds a readable standard title', () => {
  assert.equal(titleFromFilename('is-14543-2024-packaged-drinking-water.pdf'), 'IS 14543:2024 Packaged Drinking Water');
  assert.equal(titleFromFilename('packaged-drinking-water.pdf'), 'Packaged Drinking Water');
});

test('stripRunningHeads removes repeated headers and bare page numbers', () => {
  const cleaned = stripRunningHeads(PAGES);
  const joined = cleaned.map((p) => p.text).join('\n');

  // The designation repeats on every page, so it is furniture and must go.
  assert.ok(!joined.includes('IS 14543 : 2024'), 'repeated running head should be stripped');
  // A line that appears on only the title page is real content, not furniture.
  assert.ok(joined.includes('INDIAN STANDARD'), 'one-off title text should survive');
  assert.ok(joined.includes('5 REQUIREMENTS'), 'real content must survive');
});

test('stripRunningHeads removes a running header that repeats on most pages', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    pageNumber: i + 1,
    text: `Bureau of Indian Standards\n${i + 1}\nBody text for page ${i + 1}.`,
  }));
  const joined = stripRunningHeads(many)
    .map((p) => p.text)
    .join('\n');
  assert.ok(!joined.includes('Bureau of Indian Standards'), 'repeated header should be stripped');
  assert.ok(!/\n1\n/.test(joined), 'bare page numbers should be stripped');
  assert.ok(joined.includes('Body text for page 3'), 'body content must survive');
});

test('chunkDocument keeps page numbers accurate and never spans a page break', () => {
  const chunks = chunkDocument({ docId: 'is-14543', docTitle: 'IS 14543:2024', pages: PAGES }, { chars: 400, overlap: 80 });

  assert.ok(chunks.length > 1, 'should produce multiple chunks');

  for (const c of chunks) {
    assert.ok(c.pageFrom >= 1 && c.pageTo >= c.pageFrom, `bad page range ${c.pageFrom}-${c.pageTo}`);
    assert.ok(c.content.length > 0, 'chunk must not be empty');
    assert.ok(c.content.length <= 400 * 1.6, `chunk too large: ${c.content.length}`);
    assert.equal(c.docId, 'is-14543');
  }

  // page_from must be the page the chunk's opening words actually came from.
  // Chunks flatten line breaks, so compare against whitespace-normalised text.
  const flatten = (s) => s.replace(/\s+/g, ' ');
  for (const c of chunks) {
    const firstWords = flatten(c.content.split(/\s+/).slice(0, 4).join(' '));
    const expected = PAGES.find((p) => p.pageNumber === c.pageFrom);
    assert.ok(
      flatten(expected.text).includes(firstWords),
      `page ${c.pageFrom} does not contain the chunk's opening words ("${firstWords}")`
    );
  }
});

test('chunkDocument detects clause numbers', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: PAGES }, { chars: 200, overlap: 40 });
  const clauses = chunks.map((c) => c.clause).filter(Boolean);
  assert.ok(clauses.length > 0, 'expected at least one clause to be detected');
  assert.ok(clauses.some((c) => /^\d+(\.\d+)*$/.test(c)), `clause not in BIS form: ${JSON.stringify(clauses)}`);
});

const BISCUIT_PAGES = [
  {
    pageNumber: 1,
    text: '1 SCOPE\nThis standard covers the manufacture of biscuits.\n\n5 REQUIREMENTS\n5.1 Moisture\nThe moisture content shall not exceed 6.0 percent by mass.\n\n5.2 Acid Insoluble Ash\nThe acid insoluble ash shall not exceed 0.05 percent on a dry basis.',
  },
  {
    pageNumber: 2,
    text: '6 SAMPLING AND TESTING\nSampling shall be carried out in accordance with Annex A.\n\nThe acidity of extracted fat shall not exceed 0.1 percent.',
  },
];

const WIDE = { chars: 1200, overlap: 200 };

test('chunkDocument breaks at clause boundaries so each requirement is citable', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: BISCUIT_PAGES }, WIDE);
  const find = (needle) => chunks.find((c) => c.content.includes(needle));

  // With a 1200-char budget a whole page fits in one chunk, which would drag
  // clauses 1 through 5.2 together and leave the answer citing only "cl. 1".
  assert.equal(find('6.0 percent').clause, '5.1');
  assert.equal(find('0.05 percent').clause, '5.2');
  assert.equal(find('acidity').clause, '6');
});

test('a clause chunk carries its own requirement and no other', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: BISCUIT_PAGES }, WIDE);
  const moisture = chunks.find((c) => c.content.includes('6.0 percent'));

  assert.ok(moisture.content.includes('5.1 Moisture'), 'the body must travel with its heading');
  assert.ok(!moisture.content.includes('0.05 percent'), 'two requirements must not be mixed');
});

test('a short chunk is not carried forward wholesale as overlap', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: BISCUIT_PAGES }, WIDE);

  // Blocks are indivisible, so a 50-char chunk under a 200-char overlap target
  // would be recycled in full and make every later chunk open with the same
  // paragraph, which wastes context and blurs the vector search.
  const copies = chunks.filter((c) => c.content.includes('This standard covers the manufacture of biscuits.')).length;
  assert.equal(copies, 1, 'the scope paragraph should appear in exactly one chunk');
});

test('chunkDocument never spans a page break, even with overlap', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: BISCUIT_PAGES }, WIDE);
  for (const c of chunks) {
    assert.equal(c.pageFrom, c.pageTo, `chunk spans pages ${c.pageFrom}-${c.pageTo}`);
  }
});

test('overlap never carries a whole chunk into the next one', () => {
  // Blocks are indivisible, so a tail loop that runs to index 0 will carry the
  // entire chunk whenever its last block is larger than the overlap target, and
  // the next chunk becomes a superset of this one. On a 929-page standard that
  // made 7.4% of chunks near-copies of their predecessor: the same text embedded
  // twice, and retrieval scoring it twice.
  const pages = [];
  for (let p = 1; p <= 12; p++) {
    pages.push({
      pageNumber: p,
      text: [
        `${p} REQUIREMENTS`,
        `The tensile strength of the pipe shall be not less than ${p}0 N per square millimetre under test conditions specified.`,
        `The elongation of the specimen shall exceed ${p} percent at the point of rupture during the standard test.`,
        `${p}.1 Wall thickness`,
        `The wall thickness shall be ${p} millimetres with a permitted deviation of plus or minus ten percent.`,
      ].join('\n'),
    });
  }

  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages }, WIDE);

  let copies = 0;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].content;
    const cur = chunks[i].content;
    const n = Math.min(120, prev.length, cur.length);
    if (n > 40 && prev.slice(0, n) === cur.slice(0, n)) copies++;
  }
  assert.equal(copies, 0, `${copies} chunk(s) open with a copy of the previous chunk`);
});

test('a small document is still split at every clause boundary', () => {
  // The minimum-seal floor stops a large standard from shattering into stubs.
  // It must not swallow a small one, whose clause boundaries are the whole point
  // and cost nothing.
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: BISCUIT_PAGES }, WIDE);
  const clauses = chunks.map((c) => c.clause).filter(Boolean);
  for (const cl of ['5.1', '5.2', '6']) {
    assert.ok(clauses.includes(cl), `clause ${cl} should still be citable, got ${clauses.join(', ')}`);
  }
});

test('a large document does not shatter into clause-sized stubs', () => {
  // A technical standard is mostly short numbered requirements. Sealing on every
  // one of them produced 7,153 chunks averaging 211 characters for a single
  // 929-page file — every one a separate embedding call, most too small to
  // retrieve usefully.
  const pages = [];
  for (let p = 1; p <= 60; p++) {
    const lines = [`${p} TESTS`];
    for (let i = 1; i <= 12; i++) {
      lines.push(`${p}.${i} The ${i === 1 ? 'wall' : 'axial'} dimension shall be ${i} millimetres plus or minus ten percent under test.`);
    }
    lines.push(`The specimen shall be conditioned at ${p} degrees for not less than twenty four hours before testing.`);
    pages.push({ pageNumber: p, text: lines.join('\n') });
  }

  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages }, WIDE);
  const lens = chunks.map((c) => c.content.length);
  const median = lens.sort((a, b) => a - b)[Math.floor(lens.length / 2)];

  assert.ok(median >= 300, `median chunk was only ${median} chars; clauses are over-sealing`);
  assert.ok(chunks.length < 60 * 12, `${chunks.length} chunks for ${60 * 12} clauses means no merging at all`);
});

const FEE_PAGES = [
  {
    pageNumber: 1,
    text: [
      'Sr. No. IS No. Fees',
      '6. IS 158:2015 1 litre 1 kg Rs 60,000.00 Rs 48,000.00 Rs 0.26 20122016',
      '7. IS 164:2015 1 litre 1 kg Rs 64,000.00 Rs 52,000.00 Rs 0.26 20122016',
      '8. IS 181:2005 1 kg Rs 45,000.00 Rs 38,000.00 Rs 0.26 01042018',
      '9. IS 219:2018 1 kg Rs 50,000.00 Rs 41,000.00 Rs 0.26 14032019',
    ].join('\n'),
  },
];

test('fee rows are not mistaken for clause headings', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: FEE_PAGES }, { chars: 1200, overlap: 200 });

  // Each row starts with "6.", "7.", "8." ... which the clause regex matches.
  // Left alone, every row would seal its own ~85-char chunk and cite itself as
  // "cl. 7" -- a row number, not a clause.
  assert.equal(chunks.length, 1, `four fee rows should coalesce, got ${chunks.length} chunk(s)`);
  assert.ok(chunks[0].content.includes('Rs 60,000.00'), 'row content must survive');
});

test('a fee row never supplies the clause citation', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: FEE_PAGES }, { chars: 1200, overlap: 200 });
  for (const c of chunks) {
    assert.ok(!/^\s*[6-9](\.\d+)*\s/.test(c.content.split('\n')[0] || ''), 'row number must not lead a chunk');
  }
});

test('a numbered requirement is still treated as a clause, not a table row', () => {
  // The table-row heuristic must not swallow real numbered prose, or clauses
  // stop being citable -- the exact failure this heuristic was added to prevent.
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: BISCUIT_PAGES }, WIDE);
  const moisture = chunks.find((c) => c.content.includes('6.0 percent'));
  assert.equal(moisture.clause, '5.1', 'numbered prose must still break and cite by clause');
});

test('chunkIndex is sequential and stable', () => {
  const chunks = chunkDocument({ docId: 'd', docTitle: 'T', pages: PAGES }, { chars: 400, overlap: 80 });
  chunks.forEach((c, i) => assert.equal(c.chunkIndex, i));
});

test('toEmbeddableText prepends provenance but leaves stored content clean', () => {
  const c = { docTitle: 'IS 14543:2024', clause: '5.2', pageFrom: 2, heading: 'Chemical Requirements', content: 'TDS shall not exceed 2000 mg/l.' };
  const embedded = toEmbeddableText(c);
  assert.ok(embedded.startsWith('[IS 14543:2024 | clause 5.2 | page 2'), embedded.slice(0, 80));
  assert.ok(embedded.includes('TDS shall not exceed 2000 mg/l.'));
  assert.equal(c.content, 'TDS shall not exceed 2000 mg/l.', 'stored content must not be mutated');
});

test('escapeHtml neutralises tag injection', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a & "b" \'c\''), 'a &amp; &quot;b&quot; &#39;c&#39;');
});

test('renderAnswerHtml escapes model output and never injects raw script', () => {
  const html = renderAnswerHtml({
    answerText: 'TDS is 2000 mg/l [[1]] <script>alert(1)</script>',
    passages: [{ docTitle: 'IS 14543:2024', clause: '5.2', pageFrom: 2, pageTo: 2, similarity: 0.81 }],
    lang: 'en',
  });
  assert.ok(!html.includes('<script>'), 'script tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('class="cite"'), '[[1]] should become a citation marker');
  assert.ok(html.includes('IS 14543:2024'), 'sources block should be present');
});

test('renderAnswerHtml escapes hostile document titles too', () => {
  const html = renderAnswerHtml({
    answerText: 'text [[1]]',
    passages: [{ docTitle: '<b>evil</b>', clause: null, pageFrom: 1, pageTo: 1, similarity: 0.7 }],
    lang: 'en',
  });
  assert.ok(!html.includes('<b>evil</b>'), 'doc titles come from filenames and must be escaped');
});

test('modelSaysNotFound detects the refusal sentinel', () => {
  assert.equal(modelSaysNotFound('NOT_FOUND'), true);
  assert.equal(modelSaysNotFound('NOT_FOUND: nothing on moisture'), true);
  assert.equal(modelSaysNotFound('The moisture content shall not exceed 6.0% [[1]]'), false);
});

test('normaliseLang falls back to en', () => {
  assert.equal(normaliseLang('hi'), 'hi');
  assert.equal(normaliseLang('xx'), 'en');
  assert.equal(normaliseLang(undefined), 'en');
  assert.equal(langName('te'), 'Telugu');
});

test('looksNonLatin detects the scripts we care about', () => {
  assert.equal(looksNonLatin('What is the TDS limit?'), false);
  assert.equal(looksNonLatin('पैकेजबंद पेयजल में TDS की सीमा क्या है?'), true);
  assert.equal(looksNonLatin('ప్యాకేజ్డ్ డ్రింకింగ్ వాటర్ లిమిట్'), true);
  assert.equal(looksNonLatin('ਪੈਕ ਕੀਤਾ ਪਾਣੀ ਦੀ ਸੀਮਾ'), true);
});

test('buildAnswerPrompt labels passages and targets the requested language', () => {
  const p = buildAnswerPrompt({
    question: 'TDS limit?',
    lang: 'hi',
    passages: [{ docTitle: 'IS 14543:2024', clause: '5.2', pageFrom: 2, pageTo: 3, content: 'TDS 2000 mg/l.' }],
  });
  assert.ok(p.includes('[1] IS 14543:2024 — Clause 5.2 — page 2-3'), p.slice(0, 200));
  assert.ok(p.includes('Answer in Hindi (Devanagari)'));
  assert.ok(p.includes('original English form'), 'must instruct keeping IS codes in English');
});
