import { config } from '../src/config.js';

const M = config.gemini.embedModel;
const DIMS = config.gemini.dims;
const url = `https://generativelanguage.googleapis.com/v1beta/models/${M}:batchEmbedContents`;

const l2 = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
};
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function embed(reqs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({ requests: reqs.map((r) => ({ model: `models/${M}`, outputDimensionality: DIMS, ...r })) }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.embeddings.map((e) => l2(e.values));
}

const doc = (text, title) => ({
  content: { parts: [{ text }] },
  taskType: 'RETRIEVAL_DOCUMENT',
  ...(title ? { title } : {}),
});

// --- Corpus: deliberately mimics real BIS clause chunks -------------------
const CORPUS = [
  { id: 'D1', title: 'IS 1011:2002 Biscuits', text: 'The moisture content shall not exceed 6.0 percent by mass. Acid insoluble ash shall not exceed 0.05 percent on the dry basis.' },
  { id: 'D2', title: 'IS 1011:2002 Biscuits', text: 'Sampling of biscuits shall be carried out in accordance with Annex A. The lot size shall not exceed 5000 kg.' },
  { id: 'D3', title: 'IS 14543:2024 Packaged Drinking Water', text: 'Total dissolved solids shall not exceed 2000 mg per litre. The product shall be free from Escherichia coli in any 100 ml sample.' },
  { id: 'D4', title: 'IS 14543:2024 Packaged Drinking Water', text: 'Lead shall not exceed 0.01 mg per litre and arsenic shall not exceed 0.01 mg per litre in packaged drinking water.' },
  { id: 'D5', title: 'IS 1489 Part 1:2015 Portland Pozzolana Cement', text: 'The compressive strength of cement mortar at 28 days shall not be less than 43.0 MPa. The setting time shall not exceed 30 minutes for initial set.' },
  { id: 'D6', title: 'IS 1293:2019 Plugs and Socket-Outlets', text: 'The socket shutter shall provide a minimum gap of 2.5 mm between the pin and the socket. The temperature rise shall not exceed 30 K.' },
  { id: 'D7', title: 'IS 16102 Part 1:2012 LED Lamps', text: 'The LED module shall withstand an endurance test of 2000 hours at the rated voltage. The lamp shall be free from ultraviolet and infrared radiation hazards.' },
];

const QUERIES = [
  { id: 'Q1 RELEVANT  ', q: 'What is the maximum moisture allowed in biscuits?', want: ['D1', 'D2'] },
  { id: 'Q2 RELEVANT  ', q: 'maximum TDS limit in packaged drinking water', want: ['D3'] },
  { id: 'Q3 RELEVANT  ', q: 'heavy metal limits lead arsenic drinking water', want: ['D4'] },
  { id: 'Q4 RELEVANT  ', q: 'compressive strength of cement after 28 days', want: ['D5'] },
  { id: 'Q5 RELEVANT  ', q: 'what is the safety gap in sockets', want: ['D6'] },
  { id: 'Q6 IRRELEVANT', q: 'How do I apply for a driving licence in Maharashtra?', want: [] },
  { id: 'Q7 IRRELEVANT', q: 'best recipe for chocolate cake', want: [] },
  { id: 'Q8 IRRELEVANT', q: 'What is the capital of France?', want: [] },
];

console.log('Embedding corpus...\n');
const docVecs = await embed(CORPUS.map((c) => doc(c.text, c.title)));
const qVecs = await embed(QUERIES.map((q) => ({ content: { parts: [{ text: q.q }] }, taskType: 'RETRIEVAL_QUERY' })));

const scores = docVecs.map((dv, i) => ({
  id: CORPUS[i].id,
  title: CORPUS[i].title,
  vec: dv,
}));

console.log('RANKING PER QUERY (cosine, higher = better)\n');
const allRelevant = [];
const allIrrelevant = [];

QUERIES.forEach((q, qi) => {
  const ranked = scores
    .map((s) => ({ id: s.id, title: s.title, sim: cos(qVecs[qi], s.vec) }))
    .sort((a, b) => b.sim - a.sim);

  console.log(`${q.id} "${q.q}"`);
  ranked.forEach((r, i) => {
    const tag = q.want.includes(r.id) ? '  <-- RELEVANT' : '';
    if (q.want.length) {
      (q.want.includes(r.id) ? allRelevant : allIrrelevant).push(r.sim);
    }
    if (i < 3 || q.want.includes(r.id)) console.log(`   ${String(r.sim.toFixed(4)).padStart(7)}  ${r.id}  ${r.title.slice(0, 42)}${tag}`);
  });
  const top = ranked[0].id;
  console.log(`   => top hit ${top} | expected ${q.want.join(',') || 'nothing'} ${q.want.includes(top) || q.want.length === 0 ? 'OK' : '*** WRONG ***'}\n`);
});

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const maxRel = Math.max(...allRelevant);
const minIrrel = Math.min(...allIrrelevant);
console.log('='.repeat(64));
console.log(`relevant   scores: min ${Math.min(...allRelevant).toFixed(4)}  max ${maxRel.toFixed(4)}  avg ${avg(allRelevant).toFixed(4)}`);
console.log(`irrelevant scores: min ${minIrrel.toFixed(4)}  max ${Math.max(...allIrrelevant).toFixed(4)}  avg ${avg(allIrrelevant).toFixed(4)}`);
console.log('='.repeat(64));
console.log(`\nA separating threshold must sit between ${minIrrel.toFixed(4)} and ${maxRel.toFixed(4)}`);
console.log(`Suggested SIMILARITY_THRESHOLD = ${(((minIrrel + maxRel) / 2)).toFixed(3)}`);
