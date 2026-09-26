import { config } from '../config.js';

/**
 * OpenRouter client.
 *
 * Four behaviours here are non-obvious, and each was learned by hitting it:
 *
 * 1. `GET /api/v1/models` does NOT list embedding models. It returns hundreds of
 *    chat models and zero embedding models, which reads as "OpenRouter cannot
 *    embed". That is wrong: `POST /api/v1/embeddings` serves embeddings fine,
 *    including models absent from the catalogue. Never use the catalogue to
 *    decide whether a model exists — probe the endpoint.
 *
 * 2. Rate limits arrive in two shapes that need opposite handling. A per-minute
 *    limit clears in seconds and should be retried; the free tier's *daily* cap
 *    does not clear until the reset and retrying just burns time. The reliable
 *    discriminator is `error.metadata.limit_source`, not the message text.
 *
 * 3. The message text is actively misleading for classification. The daily-cap
 *    error reads "Add 10 credits to unlock 1000 free model requests per day",
 *    so a substring search for "credits" reports a credit problem for what is
 *    really a free-tier quota. Classifying on text alone is how a transient
 *    limit becomes a permanent-looking failure.
 *
 * 4. `?dimensions=` is not uniformly supported. lfm-2.5-embedding-350m has a
 *    fixed 1024 and 400s on a mismatched request; text-embedding-3-small returns
 *    1536 and truncates on request. The field is therefore never sent, and the
 *    width of the response is verified instead.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DAILY_FREE_HINT =
  'OpenRouter free models are capped per DAY, not per minute (X-RateLimit-Limit: 50 on this key). ' +
  'The cap does not clear by waiting; it resets at the epoch in X-RateLimit-Reset. ' +
  'Add credits to raise the limit, or set EMBED_PROVIDER to a model without a free-tier cap.';

/** Pull the structured error out of a failed response. */
async function readError(res, label) {
  const raw = await res.text().catch(() => '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const err = new Error(`${label} failed: HTTP ${res.status} ${raw.slice(0, 300)}`);
  err.status = res.status;
  err.body = raw;
  err.rateLimit = {
    limit: Number(res.headers.get('x-ratelimit-limit')) || null,
    remaining: Number(res.headers.get('x-ratelimit-remaining')) || null,
    reset: Number(res.headers.get('x-ratelimit-reset')) || null,
  };
  if (parsed?.error) {
    err.code = parsed.error.code ?? null;
    err.limitSource = parsed.error.metadata?.limit_source ?? null;
    err.remedyHint = parsed.error.metadata?.remedy_hint ?? null;
  }
  return err;
}

/**
 * Is this a free-tier daily cap?
 *
 * Matches on `limit_source` / the "per-day" phrasing and deliberately does NOT
 * look for "credits" — the cap's own message advertises buying credits, so a
 * text search for that word misreads a quota as a billing failure.
 */
export function isDailyCap(err) {
  if (err?.limitSource === 'openrouter_free_tier_daily') return true;
  const t = `${err?.message ?? ''} ${err?.remedyHint ?? ''}`.toLowerCase();
  return t.includes('free-models-per-day') || t.includes('free_tier_daily') || t.includes('daily reset');
}

/** A genuine billing failure, as opposed to an exhausted free allowance. */
export function isOutOfCredit(err) {
  if (err?.status === 402) return true;
  if (err?.code === 'insufficient_quota') return true;
  const t = `${err?.message ?? ''}`.toLowerCase();
  return t.includes('insufficient credits') || t.includes('insufficient_quota') || t.includes('negative balance');
}

/**
 * The model's input limit, in tokens.
 *
 * The 400 body is precise ("Embedding input has 741 tokens, exceeding the model
 * maximum of 512") which makes this diagnosable instead of mysterious — and the
 * fix is a chunk-size change, not a retry.
 */
export function tokenLimitExceeded(err) {
  if (err?.status !== 400) return null;
  const m = /has (\d+) tokens, exceeding the model maximum of (\d+)/.exec(String(err?.message ?? ''));
  return m ? { tokens: Number(m[1]), max: Number(m[2]) } : null;
}

/** A per-minute or transient limit: worth waiting out. */
export function isTransientLimit(err) {
  if (err?.status !== 429) return false;
  if (isDailyCap(err)) return false;
  const t = `${err?.message ?? ''}`.toLowerCase();
  return t.includes('rate limit') || t.includes('too many requests') || t.includes('per-min');
}

function errorFor(err, label) {
  const daily = isDailyCap(err);
  if (daily) {
    const reset = err.rateLimit?.reset ? new Date(err.rateLimit.reset).toISOString() : 'unknown';
    const e = new Error(`${label} hit OpenRouter's free-tier DAILY cap. ${DAILY_FREE_HINT} (resets ${reset})`);
    e.dailyQuota = true;
    e.status = err.status;
    e.source = 'openrouter_free_tier_daily';
    return e;
  }
  if (isOutOfCredit(err)) {
    const e = new Error(`${label} failed: OpenRouter credits exhausted. Top up at openrouter.ai/credits.`);
    e.outOfCredit = true;
    e.status = err.status;
    return e;
  }
  const tok = tokenLimitExceeded(err);
  if (tok) {
    const e = new Error(
      `${label} rejected a ${tok.tokens}-token input; ${config.embedding.model} accepts at most ` +
        `${tok.max} tokens. Lower CHUNK_CHARS in .env and re-run the ingest, or switch to a model with a ` +
        'larger context window. Retrying cannot help — the input is genuinely too long.'
    );
    e.tooLong = true;
    e.status = err.status;
    return e;
  }
  return err;
}

async function postJson(path, body, { label, attempts = 6, baseDelayMs = 1000 } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${config.openrouter.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw errorFor(await readError(res, label), label);
      return res.json();
    } catch (err) {
      lastErr = err;

      // Deterministic failures. Retrying an input that is too long, a 400, or an
      // exhausted daily cap just spends the remaining quota on identical errors.
      if (err.tooLong || err.dailyQuota || err.outOfCredit || !isTransientLimit(err) && err.status === 400) {
        throw err;
      }

      const transient = isTransientLimit(err) || [500, 502, 503, 504].includes(err.status);
      if (!transient || attempt === attempts) break;

      // Respect the server's reset if it gave us one, otherwise back off. The
      // ceiling matters: without it, exponential backoff re-fires inside the same
      // exhausted minute and every attempt is wasted.
      const resetIn = err.rateLimit?.reset ? err.rateLimit.reset - Date.now() : null;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000) + Math.random() * 400;
      const delay = resetIn && resetIn > 0 && resetIn < 60_000 ? resetIn + 500 : backoff;

      console.warn(
        `[openrouter] ${label} failed (attempt ${attempt}/${attempts}): ` +
          `${String(err.message).slice(0, 130)} — retrying in ${Math.round(delay / 1000)}s`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Embed a batch of texts.
 *
 * OpenAI-compatible shape: `input` takes a string or an array and
 * `data[i].embedding` comes back in the same order. Order is preserved because
 * ingest pairs each vector with its chunk positionally — sorting would silently
 * misalign every citation.
 *
 * `dimensions` is deliberately not sent; see the module comment.
 */
export async function embed(items) {
  if (!items.length) return [];

  const data = await postJson(
    '/embeddings',
    { model: config.embedding.model, input: items },
    { label: 'embeddings' }
  );

  const vectors = (data.data ?? []).map((d) => d.embedding);
  if (vectors.length !== items.length) {
    throw new Error(
      `embeddings returned ${vectors.length} vector(s) for ${items.length} input(s); ` +
        'chunks and vectors would be misaligned.'
    );
  }

  for (const v of vectors) {
    if (v.length !== config.embedding.dims) {
      throw new Error(
        `Embedding width mismatch: ${config.embedding.model} returned ${v.length} dims but ` +
          `EMBED_DIMS=${config.embedding.dims}. Set EMBED_DIMS=${v.length} and re-run the ingest — ` +
          'stored vectors are only comparable within one model and width.'
      );
    }
  }

  return vectors;
}

/**
 * The text actually sent for a document.
 *
 * Gemini's batch endpoint carries a native `title` field that puts a chunk's
 * standard identity into the vector space, which is why "how much cement" can
 * retrieve a chunk about IS 1489 that never names the standard. This endpoint has
 * no equivalent field, so the title is prepended to carry the same signal. The
 * cost is a mild bias toward title-bearing chunks, which is the right trade for
 * technical standards where the designation is the point.
 */
export function documentText({ text, title }) {
  if (!config.embedding.prefixTitle || !title) return text;
  return `${title}\n\n${text}`;
}

function l2Normalise(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  return vec.map((x) => x / norm);
}

/** Embed `{ text, title }` documents, in order. */
export async function embedDocuments(items) {
  if (!items.length) return [];
  return (await embed(items.map(documentText))).map(l2Normalise);
}

/**
 * Embed one query.
 *
 * Deliberately not title-prefixed: a query is not a document, and prefixing it
 * would push queries away from the region that title-prefixed documents occupy.
 * That is the retrieval asymmetry Gemini solves with `taskType`; here the correct
 * move is to avoid creating the mismatch rather than try to emulate it.
 */
export async function embedQuery(text) {
  const [vec] = await embed([text]);
  return l2Normalise(vec);
}

/** Chat completion. The only translation is Gemini's shapes into OpenAI's. */
export async function chat({ systemInstruction, prompt, temperature, maxOutputTokens }) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  messages.push({ role: 'user', content: prompt });

  const data = await postJson(
    '/chat/completions',
    {
      model: config.generation.model,
      messages,
      temperature: temperature ?? config.generation.temperature,
      max_tokens: maxOutputTokens ?? config.generation.maxOutputTokens,
    },
    { label: 'chat/completions' }
  );

  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`chat/completions returned no content: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return text;
}

export const name = 'openrouter';
export const hasKey = () => Boolean(config.openrouter.apiKey);
