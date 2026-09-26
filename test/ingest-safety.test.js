import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPrune } from '../scripts/ingest.js';

const OK = { file: 'a.pdf', chunks: 120, pages: 9 };
const OK2 = { file: 'b.pdf', chunks: 40, pages: 3 };

test('a fully successful run prunes', () => {
  const d = shouldPrune({ results: [OK, OK2], selectedCount: 2, keepStale: false });
  assert.equal(d.prune, true);
  assert.equal(d.reason, null);
});

test('an embedding failure must not prune — this emptied the corpus once', () => {
  // Regression: a 429 on the single new document was swallowed by the per-file
  // catch, and pruning then deleted all six previously-indexed documents. The
  // run finished with 0 documents and no error exit.
  const results = [OK, { file: 'is.sp.21.2005.pdf', error: 'batchEmbedContents failed: HTTP 429' }];
  const d = shouldPrune({ results, selectedCount: 2, keepStale: false });
  assert.equal(d.prune, false, 'pruned despite a failed document');
  assert.equal(d.reason, 'ingest-failed');
  assert.deepEqual(d.failed, ['is.sp.21.2005.pdf']);
});

test('a single failure blocks pruning even when other documents succeeded', () => {
  const d = shouldPrune({
    results: [OK, { file: 'bad.pdf', error: 'boom' }],
    selectedCount: 2,
    keepStale: false,
  });
  assert.equal(d.prune, false);
});

test('a document yielding no chunks is treated as a failure', () => {
  // A scan that extracts nothing is not a successful "no-op" — pruning on it
  // would trade a working corpus for an empty one.
  const d = shouldPrune({
    results: [OK, { file: 'scan.pdf', skipped: true, reason: 'no_chunks' }],
    selectedCount: 2,
    keepStale: false,
  });
  assert.equal(d.prune, false);
  assert.equal(d.reason, 'ingest-failed');
});

test('an already-indexed document counts as success, not a failure', () => {
  // Re-running without --force is a no-op for unchanged files. That must not
  // look like a failure, or pruning would never happen on a re-run.
  const d = shouldPrune({
    results: [{ file: 'a.pdf', skipped: true, reason: 'unchanged' }],
    selectedCount: 1,
    keepStale: false,
  });
  assert.equal(d.prune, true);
});

test('nothing landing blocks pruning', () => {
  const d = shouldPrune({ results: [], selectedCount: 0, keepStale: false });
  assert.equal(d.prune, false);
  assert.equal(d.reason, 'empty-selection');
});

test('--keep-stale blocks pruning', () => {
  const d = shouldPrune({ results: [OK], selectedCount: 1, keepStale: true });
  assert.equal(d.prune, false);
  assert.equal(d.reason, 'keep-stale');
});
