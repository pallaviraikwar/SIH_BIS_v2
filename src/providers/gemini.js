import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

/**
 * Google Gemini provider.
 *
 * Retained as a generation fallback and as an alternative embedding source. Its
 * free tier is the reason it is no longer the default: ~20 generateContent
 * requests per day per model, and 1000 embedContent requests per day, both of
 * which arrive as a 429 with a `retryDelay` of under a minute that is wrong for a
 * daily cap. Believing that hint means retrying for minutes against a quota that
 * resets tomorrow, so daily caps are detected and reported immediately instead.
 */

const EMBED_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * L2-normalise a vector.
 *
 * Gemini's reduced-width vectors are not unit length, and pgvector's cosine
 * operator assumes they are. Comparing unnormalised vectors against a `vector`
 * column silently changes every similarity score, which is why this is not
 * optional and not conditional.
 */
function l2Normalise(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  return vec.map((x) => x / norm);
}

function assertDims(vec) {
  if (vec.length !== config.embedding.dims) {
    throw new Error(
      `Embedding width mismatch: model returned ${vec.length} dims but EMBED_DIMS=${config.embedding.dims}. ` +
        'Either set EMBED_DIMS to the returned width, or pick a width the model supports ' +
        '(gemini-embedding-001 supports 128-3072, and pgvector can only index up to 2000).'
    );
  }
}

function isRetryable(err) {
  const status = err?.status ?? err?.code;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('overloaded');
}

function isQuotaError(err) {
  const status = err?.status ?? err?.code;
  if (status === 429) return true;
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted');
}

/**
 * True when the 429 is a *daily* cap rather than a per-minute window.
 *
 * The `retryDelay` is present and short either way, so it is useless as a
 * discriminator — a daily cap will cheerfully suggest "retry in 35s" for the next
 * 11 hours. The quotaId is the reliable signal:
 *
 *   embedding   EmbedContentRequestsPerDayPerProjectPerModel-FreeTier
 *   generation  GenerateContentRequestsPerDayPerProjectPerModel-FreeTier
 *
 * Note "PerProject": quota is metered on the Cloud project, NOT the API key. A
 * freshly generated key in the same project inherits an exhausted bucket, which
 * was verified here — two different keys returned byte-identical 429s. Rotating a
 * key is therefore not a way to recover from a daily cap; only a new project or
 * enabling billing is.
 */
function isDailyQuotaError(err) {
  return /RequestsPerDay|PerDayPerProject|DailyPerProject/i.test(String(err?.message ?? ''));
}

/**
 * The enforced daily cap, when the error states it.
 *
 * Google returns the real number in the message ("Quota exceeded for metric:
 * generativelanguage.googleapis.com/embed_content_free_tier_requests, limit:
 * 1000, model: gemini-embedding-1.0"), so the limit can be reported rather than
 * guessed at. This corrected a real misconception: the enforced embedding cap was
 * measured at 1000/day, not the 10000/day that was assumed going in.
 */
function statedDailyLimit(err) {
  const m = /limit:\s*(\d+),\s*model:\s*([^\s"\\]+)/.exec(String(err?.message ?? ''));
  return m ? { limit: Number(m[1]), model: m[2] } : null;
}

/**
 * Which quota ran out.
 *
 * The two are capped independently — roughly 1000 embedding requests/day versus
 * 20 generation requests/day — so reporting the wrong one sends an operator to
 * the wrong limit. This distinction was worth real money here: a single hardcoded
 * "generation quota" message asserted that embeddings were fine while embedding
 * was exactly what had stopped working, and a wasted ingest proved it.
 */
function exhaustedMetric(err) {
  const msg = String(err?.message ?? '');
  if (/embed/i.test(msg)) return 'embedding';
  if (/generate|content/i.test(msg)) return 'generation';
  return 'unknown';
}

const DAILY_QUOTA_HELP = {
  generation:
    'The Gemini free tier allows only ~20 generateContent requests per DAY per model, and this ' +
    "project's daily generation quota is exhausted. Enabling billing removes the cap; otherwise " +
    'wait for the reset at midnight Pacific. Embedding quota is a separate bucket. ' +
    'Set GEN_PROVIDER=openrouter to avoid this entirely.',
  embedding:
    "The Gemini free tier's embedding cap is 1000 requests per DAY per project per model " +
    '(EmbedContentRequestsPerDayPerProjectPerModel-FreeTier, measured on this project), and it is ' +
    'exhausted. Quota is per PROJECT, so a new API key in the same project does not help — ' +
    'enabling billing or creating a new project does. The reset is at midnight Pacific. ' +
    "Google's suggested retryDelay of about 36s is a per-minute hint and is wrong here. " +
    'Alternatively set EMBED_PROVIDER=openrouter, which has no daily cap on paid models.',
  unknown:
    'A Gemini daily quota is exhausted. Enabling billing removes the cap; otherwise wait for the ' +
    'reset at midnight Pacific.',
};

function dailyQuotaError(err) {
  const metric = exhaustedMetric(err);
  const stated = statedDailyLimit(err);
  const limitNote = stated ? ` The enforced cap is ${stated.limit}/day for ${stated.model}.` : '';
  const e = new Error(`Daily Gemini ${metric} quota exhausted.${limitNote} ${DAILY_QUOTA_HELP[metric]}`);
  // Preserved so the dispatcher can treat a daily cap as a fallback-worthy error
  // without re-parsing the message.
  e.dailyQuota = true;
  e.metric = metric;
  return e;
}

/**
 * An input the model refuses because it is too long.
 *
 * gemini-embedding-001 accepts 2,048 input tokens, and a batch fails as a whole
 * if any single member is over. Since one oversized chunk can therefore abort a
 * 3,445-chunk ingest, this is detected explicitly and reported with the fix
 * rather than left to surface as an opaque 400.
 */
export function tokenLimitExceeded(err) {
  // Only a client error can be an input-length problem. Without this guard a
  // retryable 500 that happens to mention "tokens" would be mistaken for one and
  // reported as a chunking bug, sending the operator to fix the wrong thing.
  if (err?.status && err.status !== 400) return null;

  const msg = String(err?.message ?? '');
  if (!/token|too long/i.test(msg)) return null;

  // The limit is the number that follows the limit-ish word, whatever connective
  // text sits between ("maximum is 2048", "limit of 2048", "exceeds 2048"). Matching
  // only one phrasing means a real error slips through and gets retried.
  const max = /(?:max(?:imum)?|limit|exceed\w*)[^0-9]{0,24}(\d{3,6})/i.exec(msg);
  // The input size is the number attached to "tokens", which may appear before or
  // after the limit.
  const tokens = /(\d{2,6})\s*tokens?\b/i.exec(msg);

  return {
    tokens: tokens ? Number(tokens[1]) : null,
    max: max ? Number(max[1]) : config.embedding.maxInputTokens,
  };
}

async function withRetry(label, fn, { attempts = 8, baseDelayMs = 1000 } = {}) {
  const genai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(genai);
    } catch (err) {
      lastErr = err;

      if (isDailyQuotaError(err)) throw dailyQuotaError(err);

      // Deterministic: the input is genuinely too long, so retrying identical
      // requests just spends the remaining daily quota to arrive at the same
      // error. Say what to change instead.
      if (err?.status === 400 || /invalid|invalid_argument/i.test(String(err?.message ?? ''))) {
        const tok = tokenLimitExceeded(err);
        if (tok) {
          const e = new Error(
            `${label} rejected an input${tok.tokens ? ` of ${tok.tokens} tokens` : ''}; ` +
              `${config.gemini.embedModel} accepts at most ${tok.max}. Lower CHUNK_CHARS in .env and ` +
              're-run the ingest — the run resumes from where it stopped. Retrying cannot help.'
          );
          e.tooLong = true;
          throw e;
        }
      }
      if (attempt === attempts || !isRetryable(err)) break;

      const quota = isQuotaError(err);
      // A quota window refills once a minute, so a 16s ceiling just burns every
      // attempt inside the same exhausted window and then gives up. Crossing the
      // window boundary is the only thing that works.
      const ceiling = quota ? 45_000 : 8_000;
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

/**
 * Embed documents in bulk.
 *
 * Uses the REST :batchEmbedContents endpoint rather than the SDK because the batch
 * form accepts a per-request `title`. That field lets a chunk carry its standard's
 * identity ("IS 14543:2024 Packaged Drinking Water") into the vector space, which
 * measurably improved retrieval in the probe. The SDK applies one config to the
 * whole call, so per-document titles would be lost.
 */
export async function embedDocuments(items) {
  if (!items.length) return [];

  const requests = items.map((it) => ({
    model: `models/${config.gemini.embedModel}`,
    content: { parts: [{ text: it.text }] },
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: config.embedding.dims,
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
      `Gemini returned ${embeddings.length} embeddings for ${items.length} inputs; ` +
        'the batch response is out of sync with the request.'
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
 *
 * Documents are embedded as RETRIEVAL_DOCUMENT and queries as RETRIEVAL_QUERY. The
 * space is trained for that pairing, so using the document type for a query
 * measurably degrades recall.
 */
export async function embedQuery(text) {
  const res = await withRetry('embedContent(query)', (genai) =>
    genai.models.embedContent({
      model: config.gemini.embedModel,
      contents: text,
      config: {
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: config.embedding.dims,
      },
    })
  );

  const values = res.embeddings?.[0]?.values;
  if (!values) throw new Error('Gemini returned no embedding for the query.');
  const vec = l2Normalise(values);
  assertDims(vec);
  return vec;
}

export async function chat({ systemInstruction, prompt, temperature, maxOutputTokens }) {
  const res = await withRetry('generateContent', (genai) =>
    genai.models.generateContent({
      model: config.gemini.genModel,
      contents: prompt,
      config: {
        systemInstruction,
        temperature: temperature ?? config.generation.temperature,
        maxOutputTokens: maxOutputTokens ?? config.generation.maxOutputTokens,
      },
    })
  );

  const text = res.text?.trim();
  if (!text) {
    const blockReason = res.candidates?.[0]?.finishReason;
    throw new Error(
      `Gemini returned an empty response${blockReason ? ` (finishReason: ${blockReason})` : ''}.`
    );
  }
  return text;
}

export const name = 'gemini';
export const hasKey = () => Boolean(config.gemini.apiKey);
