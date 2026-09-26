import { config } from '../src/config.js';
import { closePool } from '../src/db.js';
import { searchOnly } from '../src/rag.js';
import { getCorpusStats } from '../src/store.js';
import { IN_CORPUS, OUT_OF_CORPUS } from '../src/probes.js';

/**
 * Measure the in-corpus and out-of-corpus similarity distributions and report
 * where the threshold should sit between them.
 *
 *   npm run calibrate
 *
 * Read the output before trusting any threshold: if the two distributions
 * overlap, no threshold separates them and the fix is the corpus or the chunking,
 * not the number. The suggested value is only printed when they do not overlap.
 *
 * Costs one embedding call per probe, so it is not free — but it is the only way
 * to check a number that silently decides whether the assistant answers or
 * refuses.
 */

const pct = (v) => `${(v * 100).toFixed(1)}%`;

async function topScore(q) {
  const { passages } = await searchOnly(q, { topK: 1, threshold: 0 });
  return passages.length ? passages[0].similarity : 0;
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0],
    max: s[s.length - 1],
    median: s[Math.floor(s.length / 2)],
    values: s,
  };
}

async function main() {
  const corpus = await getCorpusStats();

  console.log(`\nCalibrating against ${corpus.docCount} document(s), ${corpus.chunkCount} chunk(s)`);
  console.log(
    `model ${config.embedding.provider}/${config.embedding.model} @ ${config.embedding.dims} dims`
  );
  console.log(`configured SIMILARITY_THRESHOLD = ${config.retrieval.threshold}\n`);

  const inScores = [];
  for (const q of IN_CORPUS) {
    const s = await topScore(q);
    inScores.push(s);
    console.log(`  IN   ${pct(s).padStart(6)}  ${q}`);
  }

  const outScores = [];
  for (const q of OUT_OF_CORPUS) {
    const s = await topScore(q);
    outScores.push(s);
    console.log(`  OUT  ${pct(s).padStart(6)}  ${q}`);
  }

  const inS = stats(inScores);
  const outS = stats(outScores);

  console.log('\n' + '='.repeat(66));
  console.log('DISTRIBUTIONS');
  console.log('='.repeat(66));
  console.log(
    `  in-corpus  (n=${inScores.length})  min ${pct(inS.min)}  median ${pct(inS.median)}  max ${pct(inS.max)}`
  );
  console.log(
    `  out-corpus (n=${outScores.length})  min ${pct(outS.min)}  median ${pct(outS.median)}  max ${pct(outS.max)}`
  );

  const gapLow = outS.max;
  const gapHigh = inS.min;

  console.log('\n' + '='.repeat(66));
  console.log('VERDICT');
  console.log('='.repeat(66));

  if (gapHigh <= gapLow) {
    const overlap = outScores.filter((s) => s >= inS.min).length;
    console.log(
      `  ✗ The distributions OVERLAP. ${overlap} out-of-corpus probe(s) score at or above the\n` +
        `    weakest in-corpus probe (${pct(inS.min)}).\n` +
        '    No threshold can separate these. Fix the corpus or the chunking, not the number.'
    );
    process.exitCode = 1;
  } else {
    const mid = (gapLow + gapHigh) / 2;
    console.log(`  ✓ Clean gap: (${pct(gapLow)}, ${pct(gapHigh)}]`);
    console.log(`    suggested SIMILARITY_THRESHOLD = ${mid.toFixed(3)}  (midpoint)`);
    console.log(
      `    margin: ${pct(mid - gapLow)} above the worst out-of-corpus probe, ` +
        `${pct(gapHigh - mid)} below the weakest in-corpus probe`
    );
    if (Math.abs(config.retrieval.threshold - mid) > 0.005) {
      console.log(
        `\n  ! Configured value ${config.retrieval.threshold} differs from the measured midpoint. ` +
          'Update SIMILARITY_THRESHOLD in .env if you accept the measurement.'
      );
    }
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('\n✗ Calibration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
