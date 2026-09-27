import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { bandFor, isLookupFragment, isDegenerate } from '../src/rag.js';
import { fuseRRF } from '../src/rank.js';
import { tidyTitle, parseIsIdentifier, passageHasIdentifier } from '../src/text.js';

const passage = (id, similarity, extra = {}) => ({
  id,
  docId: 'd',
  docTitle: 'SP 21',
  pageFrom: 1,
  pageTo: 1,
  clause: null,
  chunkIndex: id,
  content: 'x',
  similarity,
  ...extra,
});

/* ------------------------------------------------------------------ *
 * Banding
 * ------------------------------------------------------------------ */

test('the four bands split on their configured boundaries', () => {
  const { threshold, softThreshold, bridgeFloor } = config.retrieval;
  assert.ok(threshold > softThreshold, 'the answer band must sit above the soft band');
  assert.ok(softThreshold > bridgeFloor, 'the soft band must sit above the bridge floor');

  assert.equal(bandFor(threshold), 'answer');
  assert.equal(bandFor(threshold + 0.01), 'answer');
  assert.equal(bandFor(threshold - 0.001), 'soft');
  assert.equal(bandFor(softThreshold), 'soft');
  assert.equal(bandFor(softThreshold - 0.001), 'bridge');
  assert.equal(bandFor(bridgeFloor), 'bridge');
  assert.equal(bandFor(bridgeFloor - 0.001), 'miss');
  assert.equal(bandFor(0), 'miss');
});

test('the overlap in the measured distributions lands in the soft band, not the miss', () => {
  // Measured on this corpus: in-corpus 0.677-0.826, out-of-corpus up to 0.708.
  // "fly ash" scored 0.6678 and was refused by 0.002 under a single 0.67 cutoff.
  // Banding exists so a real question that just misses the bar still gets read
  // instead of being thrown away.
  assert.equal(bandFor(0.6678), 'soft', 'a real question is being refused outright');
  assert.equal(bandFor(0.61), 'soft');
});

test('the residual overlap above the answer threshold is documented, not hidden', () => {
  // The bands cannot fix this: an out-of-corpus question scoring 0.708 is above
  // the 0.67 answer threshold and genuinely looks answerable. Lowering the
  // threshold to exclude it would put real in-corpus questions back in the soft
  // band. The only defence left is that the model can decline, which drops the
  // reply to the near-miss path and names the clause it actually saw.
  assert.ok(0.708 > config.retrieval.threshold, 'this test assumes 0.708 clears the threshold');
  assert.equal(bandFor(0.708), 'answer');
});

test('every measured band boundary is inclusive on the right side', () => {
  // Off-by-one here silently changes which questions reach the model.
  for (const [edge, expected] of [
    [config.retrieval.threshold, 'answer'],
    [config.retrieval.softThreshold, 'soft'],
    [config.retrieval.bridgeFloor, 'bridge'],
  ]) {
    assert.equal(bandFor(edge), expected, `bandFor(${edge}) should be ${expected}`);
    assert.notEqual(bandFor(edge - 0.01), expected, `bandFor(${edge - 0.01}) should not be ${expected}`);
  }
});

test('showNearestFrom sits above the bridge floor and inside the soft band', () => {
  // The two thresholds answer different questions and both are needed.
  // `bridgeFloor` asks "is anything resembling this reachable at all?" and
  // `showNearestFrom` asks "is it close enough that quoting the clause helps?".
  const { bridgeFloor, softThreshold, showNearestFrom } = config.retrieval;
  assert.ok(showNearestFrom > bridgeFloor, 'nothing to suppress in the bridge band otherwise');
  assert.ok(
    showNearestFrom <= softThreshold,
    'a soft-band question the model declines must still be able to show its clause'
  );
});

test('a bridge result below showNearestFrom would not quote a clause', () => {
  // The observed case this exists for: "tell me about the plastics" scored 0.5919
  // and was answered with a table-scratch requirement, offered as the closest thing
  // the index had. Out-of-corpus questions here measure 0.466-0.708, so a clause
  // quoted from inside that range is a coincidence of vocabulary, not a near miss.
  assert.equal(bandFor(0.5919), 'bridge', 'the failing case was in the bridge band');
  assert.ok(
    0.5919 < config.retrieval.showNearestFrom,
    'a score inside the measured out-of-corpus range must not be quoted as a near match'
  );
});

test('a real near miss above showNearestFrom would still quote its clause', () => {
  // The suppression must not throw away the genuinely useful case. A soft-band hit
  // the model declines is the one situation where naming the clause is informative,
  // and it scores at or above showNearestFrom.
  assert.equal(bandFor(config.retrieval.softThreshold), 'soft');
  assert.ok(config.retrieval.softThreshold >= config.retrieval.showNearestFrom);
  assert.ok(config.retrieval.showNearestFrom >= config.retrieval.softThreshold - 0.05);
});

/* ------------------------------------------------------------------ *
 * Lookup fragments
 * ------------------------------------------------------------------ */

test('a bare term is a lookup, not a question', () => {
  // "fly ash" was being sent to the generator, which returned the heading "Fly Ash"
  // verbatim: five seconds of CPU to echo the user's own two words, delivered as a
  // successful answer with a Sources block attached.
  for (const q of ['fly ash', 'waterproofing', 'concrete cube', 'bricks?', 'pozzolana']) {
    assert.equal(isLookupFragment(q), true, `"${q}" should be treated as a lookup`);
  }
});

test('an IS number is a lookup however it is punctuated', () => {
  for (const q of ['IS 456', 'is 456', 'is 456:2000', 'IS  10262 : 2019']) {
    assert.equal(isLookupFragment(q), true, `"${q}" should be treated as a lookup`);
  }
});

test('an actual question is not a lookup', () => {
  for (const q of [
    'what is fly ash',
    'tell me about fly ash',
    'how many bricks per cubic meter',
    'the compressive strength of concrete per IS code',
    'is fly ash allowed in concrete',
  ]) {
    assert.equal(isLookupFragment(q), false, `"${q}" should be answered, not located`);
  }
});

test('an empty query is neither', () => {
  assert.equal(isLookupFragment(''), false);
  assert.equal(isLookupFragment('   '), false);
  assert.equal(isLookupFragment(null), false);
});

/* ------------------------------------------------------------------ *
 * Reciprocal-rank fusion
 * ------------------------------------------------------------------ */

test('a chunk found by both retrievers outranks one found by either', () => {
  const vector = [passage(1, 0.8), passage(2, 0.7), passage(3, 0.6)];
  const keyword = [passage(2, 0.65), passage(9, 0.4), passage(1, 0.8)];
  const fused = fuseRRF(vector, keyword, { limit: 5 });

  assert.equal(fused[0].id, 2, 'the chunk found by both arms did not rank first');
  const both = fused.find((r) => r.id === 2);
  assert.equal(both.vectorRank, 2);
  assert.equal(both.keywordRank, 1);
});

test('fusion never invents a chunk that neither retriever returned', () => {
  const fused = fuseRRF([passage(1, 0.8)], [passage(2, 0.5)], { limit: 10 });
  assert.deepEqual(fused.map((r) => r.id).sort(), [1, 2]);
});

test('fusion preserves the true cosine similarity, not a fused score', () => {
  // The bands are calibrated against cosine similarity, so a row arriving from the
  // keyword arm has to carry a real similarity or it cannot be banded at all.
  const fused = fuseRRF([passage(1, 0.8)], [passage(2, 0.52)], { limit: 10 });
  const fromKeyword = fused.find((r) => r.id === 2);
  assert.equal(fromKeyword.similarity, 0.52);
  assert.ok(fromKeyword.fused > 0);
  assert.ok(fromKeyword.fused < 0.05, 'a fused score should not be mistaken for a similarity');
});

test('fusion dedupes a chunk both retrievers returned', () => {
  const fused = fuseRRF([passage(1, 0.8)], [passage(1, 0.8)], { limit: 10 });
  assert.equal(fused.length, 1);
  assert.ok(fused[0].fused > 1 / 61, 'both contributions were not summed');
});

test('fusion is deterministic for equal scores', () => {
  // Otherwise the Sources list reshuffles itself under the user on refresh.
  const rows = [passage(2, 0.5), passage(1, 0.5), passage(3, 0.5)];
  const a = fuseRRF(rows, [], { limit: 3 }).map((r) => r.id);
  const b = fuseRRF(rows, [], { limit: 3 }).map((r) => r.id);
  assert.deepEqual(a, b);
});

test('fusion copes with one retriever returning nothing', () => {
  const fused = fuseRRF([passage(1, 0.8)], [], { limit: 5 });
  assert.equal(fused.length, 1);
  assert.equal(fused[0].id, 1);
  assert.equal(fuseRRF([], [], { limit: 5 }).length, 0);
});

/* ------------------------------------------------------------------ *
 * Standard identifiers
 * ------------------------------------------------------------------ */

test('an IS identifier is parsed out of the several ways it is written', () => {
  assert.deepEqual(parseIsIdentifier('IS 456'), { code: '456', year: null });
  assert.deepEqual(parseIsIdentifier('is 456:2000'), { code: '456', year: '2000' });
  assert.deepEqual(parseIsIdentifier('Tell me about IS 10262 : 2019 please'), {
    code: '10262',
    year: '2019',
  });
  assert.equal(parseIsIdentifier('fly ash'), null);
  assert.equal(parseIsIdentifier('what is concrete'), null);
});

test('identifier promotion only fires on a passage that really prints it', () => {
  const id = { code: '456', year: null };
  assert.equal(passageHasIdentifier({ content: 'refer to IS 456: 2000 Code of practice' }, id), true);
  // The number is a different standard.
  assert.equal(passageHasIdentifier({ content: 'as per IS 1077 : 1992' }, id), false);
  // Right code, wrong year.
  assert.equal(
    passageHasIdentifier({ content: 'IS 456: 1960' }, { code: '456', year: '2000' }),
    false
  );
  assert.equal(passageHasIdentifier({ content: 'IS1456 something' }, id), false, 'a substring matched');
  assert.equal(passageHasIdentifier({ content: 'no numbers here' }, id), false);
  assert.equal(passageHasIdentifier({}, null), false);
});

/* ------------------------------------------------------------------ *
 * Suggestion titles
 * ------------------------------------------------------------------ */

test('a title cut mid-word is repaired to a whole word', () => {
  assert.equal(
    tidyTitle('Low density polyethylene pipes for potable water supp', true),
    'Low density polyethylene pipes for potable water'
  );
});

test('a title that was never cut is left alone', () => {
  // An earlier version trimmed at the last space unconditionally and turned
  // "Specification for clay paving bricks" into "Specification for clay paving".
  assert.equal(
    tidyTitle('Specification for clay paving bricks', false),
    'Specification for clay paving bricks'
  );
});

test('a revision note is dropped', () => {
  assert.equal(
    tidyTitle('Methods of test for ready mixed paints and enamels (second revision)', false),
    'Methods of test for ready mixed paints and enamels'
  );
  assert.equal(
    tidyTitle('Specification for fabricated PVC fittings (first revision)', false),
    'Specification for fabricated PVC fittings'
  );
});

test('a revision note stranded mid-title by the cap is dropped too', () => {
  // The 100-character cap can land in the middle of a title, leaving the note
  // stranded well before the end. It is still index metadata.
  assert.equal(
    tidyTitle('Specification for fabricated PVC fitting water supplies (first revision) Part I General', true),
    'Specification for fabricated PVC fitting water supplies Part I General'
  );
});

test('a mid-title parenthetical that is not a revision note is kept', () => {
  // "(including ...)" is real title text; stripping every bracket would quietly
  // rewrite the catalogue. Uncapped, so no repair runs at all.
  assert.equal(
    tidyTitle('Specification for clay pipes (including socketed pipes) Part 1', false),
    'Specification for clay pipes (including socketed pipes) Part 1'
  );
});

test('a cap that severed a trailing note is repaired', () => {
  // The 100-character cap has no delimiter to stop at, so it can cut straight
  // through a "(first revision)" and leave an unbalanced bracket that renders as
  // literal "(first" in the sidebar.
  const out = tidyTitle('Specification for PVC fittings and accessories (first', true);
  assert.ok(!out.includes('('), `an unbalanced bracket survived: ${out}`);
  assert.equal(out, 'Specification for PVC fittings and accessories');
});

test('a balanced note that was not at the end is left intact', () => {
  // A mid-string parenthetical is real title text, not a severed tail. Stripping
  // every "(" would quietly rewrite the catalogue.
  const out = tidyTitle('Code of practice for use of RCC pipes (including', true);
  assert.ok(!out.includes('('), `an unbalanced bracket survived: ${out}`);
  assert.equal(out, 'Code of practice for use of RCC pipes');
});

test('a revision note at the end does not cost the preceding word', () => {
  // Regression: the strip realigns the string, and an unconditional space cut
  // after it then removed " and enamels" on top.
  assert.equal(
    tidyTitle('Methods of test for ready mixed paints and enamels (second revision)', true),
    'Methods of test for ready mixed paints and enamels'
  );
});

test('a title too short to be a title is dropped rather than shown as a stub', () => {
  assert.equal(tidyTitle('Water', false), '');
  assert.equal(tidyTitle('', false), '');
  assert.equal(tidyTitle('Pipes for', true), '');
});

test('the IS designation is stripped from a title', () => {
  assert.equal(
    tidyTitle('IS 3583:1988 Specification for clay paving bricks', false),
    'Specification for clay paving bricks'
  );
});

/* ------------------------------------------------------------------ *
 * Existing degeneracy guard
 * ------------------------------------------------------------------ */

test('a repetition loop is still detected', () => {
  const looped = 'The minimum stress required for the pipe to be safe is recorded. '.repeat(6);
  assert.equal(isDegenerate(looped), true);
});
