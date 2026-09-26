import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config, assertConfig, providerConfigured, GEN_PROVIDERS, EMBED_PROVIDERS } from '../src/config.js';
import { documentText, queryText, hasKey, name } from '../src/providers/ollama.js';
import { buildAnswerPrompt, fitPassagesToBudget, passagesForPrompt } from '../src/prompts.js';

/**
 * The local provider is configured by default, so these lock down the three ways
 * it can fail quietly:
 *
 *   - a task prefix that stops being applied, which degrades retrieval without
 *     erroring;
 *   - a context budget that stops trimming, which hands a local model more
 *     evidence than its window holds and gets it silently truncated server-side;
 *   - a provider that needs no credential being treated as one that does, which
 *     rejects a configuration that is perfectly ready to run.
 */

function mkPassage(i, content) {
  return {
    docId: 'is.sp.21.2005',
    docTitle: 'IS 1489:2005',
    clause: `5.${i}`,
    pageFrom: 10 + i,
    pageTo: 10 + i,
    content,
  };
}

const SMALL = 'Water content shall not exceed 0.5 percent by mass.';
const LARGE = 'x'.repeat(4000);

test('a document is embedded behind the search_document prefix', () => {
  const out = documentText({ text: SMALL, title: 'IS 1489:2005' });
  assert.ok(out.startsWith('search_document:'), `expected the task prefix, got: ${out.slice(0, 40)}`);
  assert.ok(out.includes('IS 1489:2005'), 'the designation must reach the vector space');
  assert.ok(out.endsWith(SMALL), 'the body must be the tail, not the head');
});

test('a query is embedded behind the search_query prefix', () => {
  const out = queryText('how much cement');
  assert.ok(out.startsWith('search_query:'), `expected the task prefix, got: ${out}`);
});

test('the prefix asymmetry is real, not decoration', () => {
  // nomic-embed-text was trained with these two prefixes to distinguish the sides
  // of a retrieval comparison. Sending the same role for both would put a query
  // and a document in the same region and quietly cost recall.
  assert.notEqual(documentText({ text: SMALL, title: 'x' }), queryText(SMALL));
});

test('prefixTitle=false still leaves the task prefix in place', () => {
  // The two are independent switches. Turning off title prefixing must not also
  // strip the prefix that tells the model which side of the comparison this is.
  const before = config.embedding.prefixTitle;
  config.embedding.prefixTitle = false;
  try {
    const out = documentText({ text: SMALL, title: 'IS 1489:2005' });
    assert.ok(out.startsWith('search_document:'));
    assert.ok(!out.includes('IS 1489:2005'), 'title must be omitted when prefixTitle is off');
  } finally {
    config.embedding.prefixTitle = before;
  }
});

test('ollama is a registered provider for both roles', () => {
  assert.ok(GEN_PROVIDERS.includes('ollama'));
  assert.ok(EMBED_PROVIDERS.includes('ollama'));
});

test('ollama is considered configured without any credential', () => {
  // Regression guard. This returned false for every unrecognised provider, which
  // made assertConfig() reject a working local setup with a message demanding an
  // API key that does not exist.
  assert.equal(providerConfigured('ollama'), true);
  assert.equal(hasKey(), true);
  assert.equal(name, 'ollama');
});

test('the default configuration validates', () => {
  // Throws on a provider/credential mismatch, an out-of-range dimension, or an
  // unknown provider name.
  assert.doesNotThrow(() => assertConfig());
});

test('every passage survives when the budget is generous', () => {
  const passages = [mkPassage(1, SMALL), mkPassage(2, SMALL), mkPassage(3, SMALL)];
  assert.equal(fitPassagesToBudget(passages, 100_000).length, 3);
});

test('the lowest-ranked passages are the ones dropped when it does not fit', () => {
  const passages = [mkPassage(1, LARGE), mkPassage(2, LARGE), mkPassage(3, LARGE)];
  const kept = fitPassagesToBudget(passages, 4000);

  assert.ok(kept.length < passages.length, 'the budget should have forced a trim');
  // Passages arrive ordered by similarity, so the ones worth losing are at the end.
  assert.equal(kept[0], passages[0], 'the best-ranked passage must survive');
  assert.equal(kept.at(-1), passages[kept.length - 1], 'a prefix of the ranking must survive');
});

test('a budget smaller than one passage still returns a passage', () => {
  // Returning zero would turn a successful retrieval into NOT_FOUND, which is
  // worse than a short answer: the model would deny evidence the database gave it.
  const passages = [mkPassage(1, LARGE)];
  const kept = fitPassagesToBudget(passages, 10);

  assert.equal(kept.length, 1, 'at least one passage must survive');
  assert.ok(kept[0].content.length < LARGE.length, 'the oversized passage must be truncated');
});

test('an empty passage list stays empty', () => {
  assert.deepEqual(fitPassagesToBudget([], 1000), []);
});

test('prompt passage labels stay contiguous and renumbered after a trim', () => {
  // If labels were left pointing at the untrimmed list, the model would cite
  // passage numbers that do not exist in the prompt, and a user could never find
  // the cited text. A citation to a passage that is not shown is indistinguishable
  // from a fabricated one.
  const passages = [mkPassage(1, LARGE), mkPassage(2, LARGE), mkPassage(3, LARGE)];
  const available = 200;
  const kept = passagesForPrompt({ question: 'how much cement', passages, lang: 'en' });
  const prompt = buildAnswerPrompt({ question: 'how much cement', passages: kept, lang: 'en' });

  const labels = [...prompt.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
  assert.deepEqual(labels, labels.map((_, i) => i + 1), `labels must be 1..n, got ${labels}`);
  assert.equal(prompt.includes(`SOURCE PASSAGES (${kept.length})`), true);
});

test('the context budget leaves room for the answer inside the model window', () => {
  // The budget is derived, not chosen. If it ever exceeds the window minus the
  // output reserve, the prompt can overflow — and an overflowing prompt to a local
  // model is silently truncated rather than rejected.
  assert.ok(
    config.retrieval.contextTokenBudget < config.ollama.numCtx,
    `budget ${config.retrieval.contextTokenBudget} must sit inside the ${config.ollama.numCtx}-token window`
  );
  assert.ok(config.generation.maxOutputTokens < config.ollama.numCtx);
});

test('the model window is wide enough for a grounded prompt', () => {
  // The real prompt is ~5,400-6,600 tokens. A window at or below that would mean
  // the model answers from a fraction of the retrieved passages.
  assert.ok(
    config.ollama.numCtx >= 8192,
    `numCtx is ${config.ollama.numCtx}; Ollama's no-GPU default of 4,096 truncates silently`
  );
});
