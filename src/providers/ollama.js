import { config } from '../config.js';

/**
 * Ollama client. Local inference via `nomic-embed-text` and `sarvam-1`.
 *
 * What this buys: no API key, no quota, no cost, no network. The corpus can be
 * re-embedded as often as the code changes, which is the only way to actually
 * verify a retrieval change. It also retires the two provider limits that were
 * blocking ingest — Gemini's free tier allows 1,000 embedding requests/day, and
 * this corpus is 3,445 chunks, so a rebuild took 3.5 days and OpenRouter's free
 * tier allows 50/day. Neither is a rate limit to tune around; both are walls.
 *
 * Four behaviours here are load-bearing, and each was verified against a running
 * Ollama rather than assumed:
 *
 * 1. `num_ctx` MUST be sent explicitly. Ollama picks a default context from
 *    available VRAM, and on a machine with no GPU that default is 4,096. This
 *    project's grounded prompt is ~5,400-6,600 tokens, so the default silently
 *    truncates the evidence. For models built from the Ollama registry the
 *    truncation is *silent*: the server trims the prompt and still answers with
 *    HTTP 200, so the model produces a confident answer from a third of the
 *    passages and nothing anywhere reports a problem. Passing `num_ctx` per
 *    request is the only reliable fix; `OLLAMA_CONTEXT_LENGTH` is a server-wide
 *    default that can still be overridden by a Modelfile.
 *
 * 2. nomic-embed-text was trained with task prefixes and Ollama's `/api/embed`
 *    exposes no `taskType` field to request them, so they are prepended here.
 *    `search_document:` on documents and `search_query:` on queries puts both
 *    sides of a comparison in the region the model was trained for, which is the
 *    same asymmetry Gemini gets natively. Verified: prefixing shifts the vector
 *    (cosine 0.9342 against the unprefixed text), so it is not a no-op.
 *
 * 3. The document prefix carries the title, which is what makes "how much
 *    cement" able to retrieve a chunk about IS 1489 that never names the
 *    standard. Gemini did this with a native `title` field; there is no such
 *    field here, so the designation leads the text instead.
 *
 * 4. Order is preserved by `/api/embed` for array input, and responses are
 *    deterministic (self-similarity 0.999999 across calls). Ingest pairs each
 *    vector with its chunk *positionally*, so a reordering here would silently
 *    misalign every citation rather than fail. The count is checked anyway,
 *    because a silent misalignment is the worst failure this codebase can have.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The prefix nomic-embed-text was trained to distinguish its two input roles. */
const DOC_PREFIX = 'search_document:';
const QUERY_PREFIX = 'search_query:';

async function readError(res, label) {
  const raw = await res.text().catch(() => '');
  const err = new Error(`${label} failed: HTTP ${res.status} ${raw.slice(0, 300)}`);
  err.status = res.status;
  err.body = raw;
  return err;
}

/**
 * A model that was never pulled.
 *
 * Distinct from every other failure because the cause is not the code, the
 * network or the request — it is a one-line fix, and Ollama's raw 404 ("model
 * not found, try pulling it first") does not make that obvious.
 */
function modelNotPulled(err) {
  if (err?.status !== 404) return false;
  const t = `${err?.message ?? ''}`.toLowerCase();
  return t.includes('not found') || t.includes('try pulling');
}

/**
 * The prompt exceeded the context window.
 *
 * Worth naming explicitly because the alternative failure is invisible: with a
 * registry model Ollama trims the prompt and answers anyway. Getting a clean
 * 400 here means the budget in prompts.js failed to trim, which is a bug worth
 * seeing, and it is strictly better than the silent truncation it prevents.
 */
function contextOverflow(err) {
  const t = `${err?.message ?? ''} ${err?.body ?? ''}`.toLowerCase();
  return t.includes('exceed_context_size') || t.includes('exceeds the available context');
}

function errorFor(err, label, model) {
  if (modelNotPulled(err)) {
    const e = new Error(
      `${label}: Ollama does not have "${model}". Run: ollama pull ${model}`
    );
    e.notPulled = true;
    e.status = err.status;
    return e;
  }
  if (contextOverflow(err)) {
    const e = new Error(
      `${label}: the prompt exceeded the ${config.ollama.numCtx}-token context window. ` +
        'Lower TOP_K or GEN_MAX_TOKENS, or raise OLLAMA_CONTEXT_LENGTH. Note that Ollama ' +
        'silently truncates an oversized prompt for registry models, so this error means the ' +
        'budget in prompts.js is not trimming as intended.'
    );
    e.contextOverflow = true;
    e.status = err.status;
    return e;
  }
  if (err?.status === 400) {
    // Ollama is local, so a 400 means the request itself is wrong. Retrying an
    // identical malformed request can only waste time.
    err.deterministic = true;
  }
  return err;
}

/**
 * POST JSON to the local server.
 *
 * Retries only what a busy local server plausibly does transiently. There is no
 * rate limit and no daily cap to sit out, so the retry ladder is short: a local
 * daemon that is genuinely down should fail fast and loudly, not be retried for
 * a minute.
 */
async function postJson(path, body, { label, attempts = 3, baseDelayMs = 400 } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${config.ollama.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Generation on CPU is slow by design here (sarvam-1 is 2B on 6 cores
        // with no GPU), so the ceiling is generous. It is not infinite: a wedged
        // request should surface as a failure the app can degrade from, not as a
        // socket that hangs until the client gives up.
        signal: AbortSignal.timeout(config.ollama.timeoutMs),
      });

      if (!res.ok) throw errorFor(await readError(res, label), label, body.model);
      return res.json();
    } catch (err) {
      lastErr = err;

      if (err.notPulled || err.contextOverflow || err.deterministic) throw err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        err.timedOut = true;
        err.deterministic = true;
        throw err;
      }

      const transient = [500, 502, 503, 504].includes(err.status);
      if (!transient || attempt === attempts) break;

      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 200;
      console.warn(
        `[ollama] ${label} failed (attempt ${attempt}/${attempts}): ` +
          `${String(err.message).slice(0, 120)} — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * The text actually sent for a document.
 *
 * The task prefix is not optional: it is how nomic-embed-text distinguishes the
 * two sides of a retrieval comparison. The title follows it so the standard's
 * designation lands in the vector space, which is what lets a question that
 * never names IS 1489 still retrieve clauses from it.
 */
export function documentText({ text, title }) {
  const head = config.embedding.prefixTitle && title ? `${title}\n\n` : '';
  return `${DOC_PREFIX} ${head}${text}`;
}

/**
 * The text actually sent for a query.
 *
 * Also not title-prefixed, and for a different reason than on OpenRouter: there
 * the advice was to avoid creating a mismatch at all, whereas here the model has
 * a first-class mechanism for expressing the asymmetry, so both sides are put in
 * the region they were trained for rather than one being left in limbo.
 */
export function queryText(text) {
  return `${QUERY_PREFIX} ${text}`;
}

function l2Normalise(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  return vec.map((x) => x / norm);
}

/**
 * Embed a batch of already-prefixed strings, in order.
 *
 * `dimensions` is never sent. nomic-embed-text is Matryoshka-capable, but
 * Ollama's `dimensions` must be *lower* than the native width, so asking for 768
 * from a 768-dim model is asking to truncate to nothing. 768 is native here and
 * is the width the pgvector column is declared at, so the honest request is no
 * request at all. The returned width is verified regardless.
 */
async function embed(inputs) {
  if (!inputs.length) return [];

  const data = await postJson(
    '/api/embed',
    { model: config.embedding.model, input: inputs },
    { label: 'embed' }
  );

  const vectors = data.embeddings ?? [];
  if (vectors.length !== inputs.length) {
    throw new Error(
      `Ollama returned ${vectors.length} vector(s) for ${inputs.length} input(s); ` +
        'chunks and vectors would be misaligned. Order is positional in this codebase.'
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

/** Embed `{ text, title }` documents, in order. */
export async function embedDocuments(items) {
  if (!items.length) return [];
  return (await embed(items.map(documentText))).map(l2Normalise);
}

/** Embed one query as a unit vector. */
export async function embedQuery(text) {
  const [vec] = await embed([queryText(text)]);
  return l2Normalise(vec);
}

/**
 * Chat completion.
 *
 * `num_ctx` is sent on every request even though `OLLAMA_CONTEXT_LENGTH` is also
 * set. The env var is a server-wide default that any Modelfile may override, and
 * a silent halving of the context window produces plausible answers built on half
 * the evidence. Sending it per request makes the prompt budget in prompts.js and
 * the window the model actually sees the same number by construction.
 */
export async function chat({ systemInstruction, prompt, temperature, maxOutputTokens }) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  messages.push({ role: 'user', content: prompt });

  // NB: no trailing assistant turn here. Prefilling one is the textbook way to
  // constrain a small model and it was tried first — it makes this model emit a
  // literal "<s>" and nothing else, because Ollama renders the turn through
  // sarvam-1's chatml template and the model then continues from the template's
  // own boundary token. Priming at the end of the user message (config
  // .generation.prefill, appended in prompts.js) achieves the same constraint and
  // works. Keeping the priming text there also means it cannot be forgotten by a
  // caller who forgets this provider.

  const data = await postJson(
    '/api/chat',
    {
      model: config.generation.model,
      messages,
      stream: false,
      options: {
        num_ctx: config.ollama.numCtx,
        temperature: temperature ?? config.generation.temperature,
        num_predict: maxOutputTokens ?? config.generation.maxOutputTokens,
        top_p: config.generation.topP,
        repeat_penalty: config.generation.repeatPenalty,
      },
    },
    { label: 'chat' }
  );

  const text = data.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`Ollama chat returned no content: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return text.trim();
}

export const name = 'ollama';
/** No credential exists. Availability is a health check, not a key. */
export const hasKey = () => true;
