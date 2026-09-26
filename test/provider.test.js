import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFallbackWorthy } from '../src/providers/index.js';
import {
  documentText,
  isDailyCap,
  isOutOfCredit,
  isTransientLimit,
  tokenLimitExceeded,
} from '../src/providers/openrouter.js';

/**
 * These lock down the two rules that are expensive to learn the hard way:
 * when generation may fall back, and that embeddings never do.
 */

test('a quota failure is worth falling back for', () => {
  assert.equal(isFallbackWorthy({ status: 429 }), true);
  assert.equal(isFallbackWorthy({ message: '429 Too Many Requests' }), true);
  assert.equal(isFallbackWorthy({ message: 'RESOURCE_EXHAUSTED' }), true);
  assert.equal(isFallbackWorthy({ message: 'Rate limit reached' }), true);
  assert.equal(isFallbackWorthy({ message: 'Insufficient credits' }), true);
});

test('a daily cap is worth falling back for even though it is not a 429', () => {
  // Gemini signals a daily quota cap with dailyQuota, not a status code. The
  // fallback may well still have quota, which is the entire point of having one.
  assert.equal(isFallbackWorthy({ dailyQuota: true, metric: 'generation' }), true);
  assert.equal(isFallbackWorthy({ dailyQuota: true, metric: 'embedding' }), true);
});

test('a bad request must NOT fall back, or the real bug gets buried', () => {
  // A wrong model name or malformed body fails identically on the other
  // provider. Falling back would hide one clear error behind a second confusing
  // one, which is strictly worse for debugging.
  assert.equal(isFallbackWorthy({ status: 400, message: 'unknown model' }), false);
  assert.equal(isFallbackWorthy({ status: 401, message: 'unauthorized' }), false);
  assert.equal(isFallbackWorthy({ status: 404, message: 'no such model' }), false);
});

test('other server faults are not silently treated as quota', () => {
  assert.equal(isFallbackWorthy({ status: 500, message: 'internal error' }), false);
  assert.equal(isFallbackWorthy({ status: 503, message: 'service unavailable' }), false);
  assert.equal(isFallbackWorthy(null), false);
  assert.equal(isFallbackWorthy(undefined), false);
});

test('a document title is prepended for OpenRouter, which has no title field', () => {
  // Gemini's batch endpoint carries a native `title`; OpenAI-compatible ones do
  // not, so the same signal has to ride along in the text.
  const out = documentText({ text: 'Clause 5.2: hardness not to exceed 500 mg/L.', title: 'IS 14543:2024' });
  assert.equal(out, 'IS 14543:2024\n\nClause 5.2: hardness not to exceed 500 mg/L.');
  assert.ok(out.startsWith('IS 14543:2024'), 'designation must lead, since that is the retrieval signal');
});

test('a document with no title is embedded unchanged', () => {
  assert.equal(documentText({ text: 'body only' }), 'body only');
  assert.equal(documentText({ text: 'body only', title: '' }), 'body only');
});

/**
 * The daily free-tier cap is a 429 whose message mentions buying credits. Reading
 * the text and concluding "out of credit" turns a quota into a billing failure,
 * which in turn turns a resumable ingest into a dead one.
 */
const DAILY_CAP_429 = {
  status: 429,
  message:
    'HTTP 429 {"error":{"message":"Rate limit exceeded: free-models-per-day. ' +
    'Add 10 credits to unlock 1000 free model requests per day","code":429,' +
    '"metadata":{"limit_source":"openrouter_free_tier_daily",' +
    '"remedy_hint":"Wait for the daily reset (see X-RateLimit-Reset), or purchase credits."}}}',
  limitSource: 'openrouter_free_tier_daily',
  rateLimit: { limit: 50, remaining: 0, reset: 1790467200000 },
};

test('the free-tier daily cap is recognised as a daily cap, not a credit failure', () => {
  assert.equal(isDailyCap(DAILY_CAP_429), true);
  assert.equal(isOutOfCredit(DAILY_CAP_429), false, 'the message advertises credits but is a quota limit');
});

test('a genuine credit failure is distinct from the free allowance', () => {
  assert.equal(isOutOfCredit({ status: 402, message: 'Payment required' }), true);
  assert.equal(isOutOfCredit({ status: 429, code: 'insufficient_quota', message: 'nope' }), true);
  assert.equal(isDailyCap({ status: 402, message: 'Payment required' }), false);
});

test('a per-minute limit is worth retrying and a daily cap is not', () => {
  const perMinute = {
    status: 429,
    message: 'HTTP 429 {"error":{"message":"Rate limit exceeded: free-models-per-min."}}',
    limitSource: 'openrouter_free_tier_per_minute',
  };
  assert.equal(isTransientLimit(perMinute), true);
  assert.equal(isTransientLimit(DAILY_CAP_429), false, 'waiting cannot clear a cap that resets tomorrow');
});

test('an over-long input is diagnosed, not retried', () => {
  // The 400 names the token count and the limit, which makes the fix obvious:
  // shorten the chunks. Retrying an input that is genuinely too long just spends
  // the remaining daily quota on identical failures.
  const err = {
    status: 400,
    message:
      'HTTP 400 {"error":{"message":"Embedding input has 741 tokens, ' +
      'exceeding the model maximum of 512."}}',
  };
  assert.deepEqual(tokenLimitExceeded(err), { tokens: 741, max: 512 });
  assert.equal(tokenLimitExceeded({ status: 400, message: 'unknown model' }), null);
});
