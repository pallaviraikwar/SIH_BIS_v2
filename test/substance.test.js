import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { isSubstantive, isDegenerate } from '../src/rag.js';

/**
 * The minimum-substance gate.
 *
 * A Hindi question about ready-mixed paints retrieved five real clauses from
 * SP 21 p. 827 (band=answer, topSimilarity 0.7694) and the model replied
 * "नहीं।". Four characters, served as a confident answer with `notFound: false`
 * and a full Sources block, because isDegenerate ignores anything under 120
 * characters and there was nothing else checking.
 *
 * These use the clause wording from that case rather than a mock, since the
 * question the gate answers is whether the reply is traceable to the evidence.
 */
const PAINT = [
  {
    text:
      '6 MARKING Each package shall bear the ISI mark, the total dissolved solids value, and the name of the manufacturer. ' +
      '2.1 TESTING METHODS Ready-mixed paints and primers shall be tested in accordance with IS 1012.',
  },
];
const CEMENT = [
  { text: '43.0 MPa The compressive strength of cement shall not be less than 43.0 MPa at 28 days.' },
];

test('a bare non-answer is rejected even when retrieval was perfect', () => {
  // The reported failure, verbatim. It shares nothing with the clauses it was
  // handed, which is the whole reason it is caught.
  assert.equal(isSubstantive('नहीं।', PAINT), false);
  assert.equal(isSubstantive('No.', PAINT), false);
  assert.equal(isSubstantive('Not found.', PAINT), false);
  assert.equal(isSubstantive('I cannot answer that question.', PAINT), false);
  assert.equal(isSubstantive('कृपया पुनः प्रयास करें।', PAINT), false);
});

test('a real answer that quotes the retrieved value is accepted', () => {
  // The case a pure length check would have broken. This is a complete and
  // correct answer to a strength question, and rejecting it would be a worse
  // bug than the one being fixed.
  assert.equal(isSubstantive('43.0 MPa', CEMENT), true);
  assert.equal(
    isSubstantive('Not less than 43.0 MPa at 28 days.', CEMENT),
    true
  );
});

test('a full paragraph is accepted on length alone', () => {
  const long =
    'The compressive strength of cement shall not be less than 43.0 MPa when tested at 28 days, ' +
    'in accordance with the procedure given in the relevant clause of the standard.';
  assert.ok(long.length >= config.generation.minSubstantiveChars);
  assert.equal(isSubstantive(long, CEMENT), true);
});

test('a figure that is not in the evidence does not buy an answer', () => {
  // A number is only evidence of grounding if the number came from the passage.
  // This one is a hallucinated 6.0 percent read off a passage that does not
  // contain it, and the gate refuses to treat it as substantive.
  assert.equal(isSubstantive('The limit is 6.0 percent.', PAINT), false);
});

test('shared content words count as grounding when there is no number', () => {
  // "printer" is a typo for "primers" and is deliberately not counted; the
  // corrected spelling shares a stem with the clause and is.
  assert.equal(isSubstantive('Follows IS 1012 testing methods.', PAINT), true);
  assert.equal(isSubstantive('The tests are described in the primer clauses.', PAINT), true);
});

test('stopwords alone never count as grounding', () => {
  // "the", "shall" and "is" appear in every clause in the index. If they counted,
  // the gate would pass literally any reply at all.
  assert.equal(isSubstantive('The answer shall be as given above.', PAINT), false);
  assert.equal(isSubstantive('That is the question for this answer.', PAINT), false);
});

test('an empty or missing answer is never substantive', () => {
  assert.equal(isSubstantive('', PAINT), false);
  assert.equal(isSubstantive('   ', PAINT), false);
  assert.equal(isSubstantive(null, PAINT), false);
  assert.equal(isSubstantive(undefined, PAINT), false);
  assert.equal(isSubstantive(42, PAINT), false);
});

test('a short answer with no evidence to check against is not substantive', () => {
  // Nothing was retrieved, so nothing can be traced. Degrading to the retryable
  // notice is the honest outcome; claiming grounding would be unfounded.
  assert.equal(isSubstantive('43.0 MPa', []), false);
  assert.equal(isSubstantive('43.0 MPa', undefined), false);
});

test('the threshold is set so a bare refusal can never clear it on length', () => {
  // If someone raises this, "नहीं।" and every other non-answer walks straight
  // through again. Keep the floor far above the shortest thing worth rejecting
  // and far below the shortest real paragraph.
  assert.ok(
    config.generation.minSubstantiveChars > 'नहीं।'.length,
    'the threshold must be above the shortest observed non-answer'
  );
  assert.ok(
    config.generation.minSubstantiveChars <= 80,
    'the threshold must stay low enough that a terse real answer is still checked on content'
  );
});

test('the substance gate is independent of the repetition-loop gate', () => {
  // They cover opposite failures and neither substitutes for the other, so a
  // future change to one must not quietly disable the other.
  assert.equal(isDegenerate('नहीं।'), false, 'the loop gate ignores short text by design');
  assert.equal(isSubstantive('नहीं।', PAINT), false, 'so the substance gate has to catch it');

  const loop = 'The limit is recorded. '.repeat(10);
  assert.equal(isDegenerate(loop), true, 'a loop is still caught structurally');
});
