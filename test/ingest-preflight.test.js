import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessIngestFeasibility, dailyCapFor } from '../scripts/ingest.js';
import { tokenLimitExceeded as geminiTokenLimit } from '../src/providers/gemini.js';

/**
 * The preflight exists because a 2-hour ingest died at 240/3445 chunks on a daily
 * cap. Resumability means that is not lost work, but it IS a run that cannot
 * finish, and that should be visible before the first embedding rather than after
 * the last one that fits.
 */

test('a corpus larger than the daily cap is blocked, with the day count spelled out', () => {
  const r = assessIngestFeasibility({
    provider: 'gemini',
    model: 'gemini-embedding-001',
    chunkCount: 3445,
    dailyCap: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.days.toFixed(1), '3.4');
  assert.match(r.blocking[0], /1000 embedding requests\/day/);
  assert.match(r.blocking[0], /resumable/i, 'the fix must say that resuming works');
});

test('a corpus that fits inside the daily cap is allowed', () => {
  const r = assessIngestFeasibility({
    provider: 'gemini',
    model: 'gemini-embedding-001',
    chunkCount: 800,
    dailyCap: 1000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
});

test('no daily cap means no block, however large the corpus', () => {
  // A paid OpenRouter model is uncapped. Blocking here would be a false refusal
  // that stops a 40-minute run over nothing.
  const r = assessIngestFeasibility({
    provider: 'openrouter',
    model: 'openai/text-embedding-3-small',
    chunkCount: 100_000,
    dailyCap: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.days, null);
});

test('caps are per-model, not per-provider: :free is capped, paid is not', () => {
  assert.equal(dailyCapFor('openrouter', 'openai/text-embedding-3-small'), null);
  assert.equal(dailyCapFor('openrouter', 'lfm-2.5-embedding-350m:free'), 50);
  assert.equal(dailyCapFor('gemini', 'gemini-embedding-001'), 1000);
  // Not `:free` on an unrelated word, and not a bare `free` model id.
  assert.equal(dailyCapFor('openrouter', 'some/free-style-model'), null);
});

test('an oversized CHUNK_CHARS is a warning, not a refusal', () => {
  // A warning rather than a hard stop: the user may know something the estimate
  // does not, and refusing outright would be overstepping.
  const r = assessIngestFeasibility({
    provider: 'gemini',
    model: 'gemini-embedding-001',
    chunkCount: 10,
    dailyCap: 1000,
  });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.warnings));
});

test('Gemini input-length errors are recognised rather than retried', () => {
  // Retrying an input that is genuinely too long spends the remaining daily quota
  // to arrive at the same error, so it must be flagged as non-retryable.
  const err = { status: 400, message: 'The input is too long: 2500 tokens, maximum is 2048' };
  const parsed = geminiTokenLimit(err);
  assert.ok(parsed, 'must be recognised as a length failure');
  assert.equal(parsed.max, 2048);
  assert.equal(parsed.tokens, 2500);

  // An auth failure is a 400 too, and must NOT be mistaken for a length problem:
  // that would send the operator to fix chunk sizes when the key is the issue.
  assert.equal(geminiTokenLimit({ status: 400, message: 'API key not valid' }), null);
  // A 500 is retryable and says nothing about input length.
  assert.equal(geminiTokenLimit({ status: 500, message: 'internal error, 500 tokens' }), null);
});

test('a length error with no stated maximum still falls back to the configured budget', () => {
  // Some Gemini errors omit the limit. Reporting the configured one is more useful
  // than reporting nothing, and it keeps the message actionable.
  const parsed = geminiTokenLimit({ status: 400, message: 'input exceeds the token limit' });
  assert.ok(parsed);
  assert.equal(parsed.max, 2048);
});
