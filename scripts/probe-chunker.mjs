import { chunkDocument } from '../src/chunker.js';

// Shaped exactly like unpdf output: one line per text item, no blank lines.
const pages = [
  {
    pageNumber: 1,
    text: [
      '1 SCOPE',
      'This standard covers the manufacture and quality requirements of biscuits,',
      'cookies and wafers intended for human consumption.',
      '5 REQUIREMENTS',
      '5.1 Moisture',
      'The moisture content shall not exceed 6.0 percent by mass.',
      '5.2 Acid Insoluble Ash',
      'The acid insoluble ash shall not exceed 0.05 percent on a dry basis.',
    ].join('\n'),
  },
  {
    pageNumber: 2,
    text: [
      '6 SAMPLING AND TESTING',
      'Sampling shall be carried out in accordance with Annex A.',
      'The acidity of extracted fat shall not exceed 1.5 percent.',
    ].join('\n'),
  },
];

const chunks = chunkDocument({ docId: 'is-1011', docTitle: 'IS 1011:2002 Biscuits', pages }, { chars: 1200, overlap: 200 });

console.log(`${chunks.length} chunk(s):\n`);
for (const c of chunks) {
  console.log(`  #${c.chunkIndex}  clause=${c.clause ?? '(none)'}  pages=${c.pageFrom}-${c.pageTo}  ${c.content.length} chars`);
  console.log(`     ${c.content.slice(0, 110).replace(/\n/g, ' | ')}...`);
}

// The whole point: clause metadata must point at the clause the text sits in.
const moisture = chunks.find((c) => c.content.includes('6.0 percent'));
console.log(`\n  moisture chunk clause = ${moisture?.clause}  (expected 5.1)`);
if (moisture?.clause !== '5.1') {
  console.error('  ✗ WRONG CLAUSE');
  process.exit(1);
}

const ash = chunks.find((c) => c.content.includes('0.05 percent'));
console.log(`  acid-ash chunk clause = ${ash?.clause}  (expected 5.2)`);
if (ash?.clause !== '5.2') {
  console.error('  ✗ WRONG CLAUSE');
  process.exit(1);
}

const fat = chunks.find((c) => c.content.includes('1.5 percent'));
console.log(`  acidity chunk clause  = ${fat?.clause}  (expected 6)`);
if (fat?.clause !== '6') {
  console.error('  ✗ WRONG CLAUSE');
  process.exit(1);
}

console.log('\n  ✓ clause attribution correct for every requirement');
