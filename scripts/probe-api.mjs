import { GoogleGenAI } from '@google/genai';
import { config } from '../src/config.js';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const M = config.gemini.embedModel;

function l2(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

console.log('--- 1. single embedContent, dims 768 ---');
try {
  const r = await ai.models.embedContent({
    model: M,
    contents: 'Moisture content shall not exceed 6.0 percent by mass.',
    config: { taskType: 'RETRIEVAL_DOCUMENT', title: 'IS 1011:2002 Biscuits', outputDimensionality: 768 },
  });
  const v = r.embeddings[0].values;
  console.log('OK dims =', v.length, '| norm =', Math.sqrt(v.reduce((s, x) => s + x * x, 0)).toFixed(6));
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
}

console.log('\n--- 2. does embedContent accept a LIST and return multiple embeddings? ---');
try {
  const r = await ai.models.embedContent({
    model: M,
    contents: ['alpha biscuit clause', 'beta cement clause'],
    config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
  });
  console.log('embeddings returned =', r.embeddings?.length, '| dims =', r.embeddings?.[0]?.values?.length);
} catch (e) {
  console.log('FAIL (so: one text per call):', e.message?.slice(0, 200));
}

console.log('\n--- 3. raw REST :batchEmbedContents ---');
try {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${M}:batchEmbedContents`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: JSON.stringify({
        requests: [
          { model: `models/${M}`, content: { parts: [{ text: 'alpha biscuit clause' }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
          { model: `models/${M}`, content: { parts: [{ text: 'beta cement clause' }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
        ],
      }),
    }
  );
  const j = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 250)}`);
  console.log('OK embeddings =', j.embeddings?.length, '| dims =', j.embeddings?.[0]?.values?.length);
  const a = l2(j.embeddings[0].values), b = l2(j.embeddings[1].values);
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  console.log('cosine(alpha,beta) =', dot.toFixed(4));
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 250));
}

console.log('\n--- 4. generateContent with gen model ---');
try {
  const r = await ai.models.generateContent({
    model: config.gemini.genModel,
    contents: 'Reply with exactly: PONG',
  });
  console.log('OK text =', JSON.stringify(r.text?.trim()));
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
}
