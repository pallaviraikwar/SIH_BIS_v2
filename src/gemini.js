import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

export const genai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const EMBED_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * L2-normalise a vector.
 *
 * This is mandatory, not an optimisation. gemini-embedding-001 only returns
 * pre-normalised vectors at its native 3072 dims; asking for a truncated width
 * (768 here) returns unnormalised vectors — measured norm was 0.583 on a real
 * call. pgvector's cosine operators handle the scale, but keeping every vector
 * unit-length makes the stored similarity scores directly comparable with the
 * thresholds in .env.
 */
function l2Normalise(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const status = err?.status ?? err?.code;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('overloaded');
}

/** Distinguishes an exhausted quota (needs a long wait) from a transient 5xx. */
function isQuotaError(err) {
  const status = err?.status ?? err?.code;
  if (status === 429) return true;
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted');
}

/**
 * True when the 429 is a *daily* cap rather than a per-minute window.
 *
 * The free tier allows only ~20 generateContent requests per day per model
 * (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), yet Google still returns
 * a `retryDelay` of ~51s with the error. Believing that hint means retrying for
 * minutes against a quota that resets tomorrow, so every request hangs instead
 * of failing usefully. Detect it and give up immediately with an actionable
 * message; enabling billing is the only real fix.
 */
function isDailyQuotaError(err) {
  const msg = String(err?.message ?? '');
  return /GenerateRequestsPerDay|PerDayPerProject|DailyPerProject/i.test(msg);
}

const DAILY_QUOTA_HELP =
  'The Gemini free tier allows only ~20 generateContent requests per DAY per model, and this ' +
  "key's daily generation quota is now exhausted. Enabling billing on the Google AI project " +
  'removes the cap; otherwise wait for the daily reset. Embedding quota is separate and still fine.';

/**
 * Retry with exponential backoff + jitter. The Gemini free tier is aggressively
 * rate limited, so ingest hammers 429s until this backs off properly.
 *
 * 429 is treated separately from 5xx on purpose. A 429 is a *quota window*, not
 * a transient blip: the free tier refills once a minute, so a 16-second backoff
 * ceiling simply burns all its attempts inside the same exhausted window and
 * then gives up. Waiting long enough to cross the window boundary is the only
 * thing that works, hence the much higher cap and attempt count below.
 */
async function withRetry(label, fn, { attempts = 8, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // A daily cap will not clear by waiting, so do not spend minutes on it.
      if (isDailyQuotaError(err)) {
        throw new Error(`Daily Gemini generation quota exhausted. ${DAILY_QUOTA_HELP}`);
      }

      if (attempt === attempts || !isRetryable(err)) break;

      const quota = isQuotaError(err);
      const ceiling = quota ? 45000 : 8000;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), ceiling) + Math.random() * 500;

      console.warn(
        `[gemini] ${label} failed (attempt ${attempt}/${attempts}): ` +
          `${String(err?.message ?? err).slice(0, 120)} — retrying in ${Math.round(delay / 1000)}s` +
          `${quota ? ' (quota window, waiting for refill)' : ''}`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function assertDims(vec) {
  if (vec.length !== config.gemini.dims) {
    throw new Error(
      `Embedding width mismatch: model returned ${vec.length} dims but EMBED_DIMS=${config.gemini.dims}. ` +
        'Either set EMBED_DIMS to the returned width, or pick a width the model supports ' +
        '(gemini-embedding-001 supports 128-3072, and pgvector can only index up to 2000).'
    );
  }
}

/**
 * Embed documents in bulk.
 *
 * Uses the REST :batchEmbedContents endpoint rather than the SDK's
 * embedContent because the batch form accepts a per-request `taskType` and
 * `title`. The `title` field is what lets a chunk carry its standard identity
 * (e.g. "IS 14543:2024 Packaged Drinking Water") into the vector space, and it
 * measurably improved retrieval in the probe. The SDK's `embedContent` applies
 * one config to the whole call, so per-document titles would be lost.
 */
export async function embedDocuments(items) {
  if (!items.length) return [];

  const requests = items.map((it) => ({
    model: `models/${config.gemini.embedModel}`,
    content: { parts: [{ text: it.text }] },
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: config.gemini.dims,
    ...(it.title ? { title: it.title } : {}),
  }));

  const data = await withRetry('batchEmbedContents', async () => {
    const res = await fetch(`${EMBED_BASE}/${config.gemini.embedModel}:batchEmbedContents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.gemini.apiKey,
      },
      body: JSON.stringify({ requests }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`batchEmbedContents failed: HTTP ${res.status} ${detail.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });

  const embeddings = data.embeddings ?? [];
  if (embeddings.length !== items.length) {
    throw new Error(
      `Gemini returned ${embeddings.length} embeddings for ${items.length} inputs; the batch response is out of sync with the request.`
    );
  }

  return embeddings.map((e) => {
    const vec = l2Normalise(e.values);
    assertDims(vec);
    return vec;
  });
}

/**
 * Embed a single search query with the asymmetric retrieval task type.
 * Documents are embedded as RETRIEVAL_DOCUMENT and queries as RETRIEVAL_QUERY;
 * the embedding space is trained for that pairing, so using the document type
 * for a query measurably degrades recall.
 */
export async function embedQuery(text) {
  const res = await withRetry('embedContent(query)', () =>
    genai.models.embedContent({
      model: config.gemini.embedModel,
      contents: text,
      config: {
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: config.gemini.dims,
      },
    })
  );

  const values = res.embeddings?.[0]?.values;
  if (!values) throw new Error('Gemini returned no embedding for the query.');
  const vec = l2Normalise(values);
  assertDims(vec);
  return vec;
}

export async function generateText({ systemInstruction, prompt, temperature = 0.1, maxOutputTokens = 1200 }) {
  const res = await withRetry('generateContent', () =>
    genai.models.generateContent({
      model: config.gemini.genModel,
      contents: prompt,
      config: {
        systemInstruction,
        temperature,
        maxOutputTokens,
      },
    })
  );

  const text = res.text?.trim();
  if (!text) {
    const blockReason = res.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned an empty response${blockReason ? ` (finishReason: ${blockReason})` : ''}.`);
  }
  return text;
}
