import 'dotenv/config';
import path from 'node:path';

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const EMBED_DIMS = num('EMBED_DIMS', 768);

/**
 * Pulled out as their own constants because the retrieval budget is derived from
 * both. Reading them back off `config` inside the object literal would be a
 * temporal-dead-zone error: `config` is still being initialised at that point.
 */
const OLLAMA_NUM_CTX = num('OLLAMA_CONTEXT_LENGTH', 8192);
const GEN_MAX_TOKENS = num('GEN_MAX_TOKENS', 700);

/** Providers that can serve `generateText`. */
export const GEN_PROVIDERS = ['openrouter', 'gemini', 'ollama'];

/** Providers that can serve embeddings. */
export const EMBED_PROVIDERS = ['openrouter', 'gemini', 'ollama'];

export const config = {
  port: num('PORT', 3000),

  /**
   * Generation.
   *
   * Ollama is the default because this project has to run a demo on a machine
   * with no API budget and no guaranteed network. OpenRouter is paid (~$0.003
   * per grounded answer) and Gemini's free tier allows ~20 generateContent
   * requests per day, so neither survives a room full of questions. Local
   * inference has no quota at all, which is a property no hosted tier offers.
   *
   * The trade is latency: sarvam-1 is a 2B model on CPU with no GPU, so answers
   * take tens of seconds. That is acceptable for a demo and would not be for a
   * production service, which is the whole reason the provider is behind config
   * rather than hardcoded.
   */
  generation: {
    provider: str('GEN_PROVIDER', 'ollama'),
    fallbackProvider: str('GEN_FALLBACK_PROVIDER', ''),
    fallbackEnabled: bool('GEN_FALLBACK', false),
    model: str('GEN_MODEL', 'mashriram/sarvam-1'),
    temperature: num('GEN_TEMPERATURE', 0.1),
    // Deliberately well under the model's 8,192-token window. The retrieved
    // passages are not a fixed size — they scale with the document mix and the
    // longest chunk is 1,942 characters — so the output reserve has to leave room
    // for the tail, and prompts.js trims the passages to whatever is left.
    maxOutputTokens: GEN_MAX_TOKENS,
  },

  /**
   * Embeddings.
   *
   * Deliberately separate from generation: different providers, different models,
   * different quotas. Conflating them is how a system ends up embedding with one
   * model while generating with another without anyone noticing.
   *
   * `dims` is a property of the model, not a free parameter:
   *   nomic-embed-text (ollama)    768, fixed. Matryoshka-capable, but Ollama's
   *                                `dimensions` must be lower than native, so
   *                                768 is requested by not requesting anything.
   *   lfm-2.5-embedding-350m        1024, fixed (rejects ?dimensions=)
   *   openai/text-embedding-3-small 1536, accepts ?dimensions= to truncate
   *   gemini-embedding-001           768 by default, 128-3072 supported
   */
  embedding: {
    provider: str('EMBED_PROVIDER', 'ollama'),
    model: str('EMBED_MODEL', 'nomic-embed-text'),
    dims: EMBED_DIMS,
    // Input budget in tokens, and it differs sharply by model. LFM accepts 512,
    // which a 1,200-character chunk (~741 tokens) blows straight through; that
    // single fact is what disqualified it. Gemini accepts 2,048 and
    // nomic-embed-text accepts 8,192, so the current chunks fit with room to
    // spare. A whole ingest can be aborted by one oversized chunk, so ingest uses
    // this to refuse up front rather than discovering the limit at chunk 3,000.
    maxInputTokens: num('EMBED_MAX_INPUT_TOKENS', 2048),
    // Conservative chars-per-token. Measured on this corpus at roughly 2.8
    // chars/token, but 2.2 is used so the estimate errs toward smaller chunks:
    // a chunk that is unnecessarily small costs a little retrieval precision,
    // whereas one that is too large costs the entire run.
    charsPerToken: num('EMBED_CHARS_PER_TOKEN', 2.2),
    // Documents carry their standard's identity in the vector space, so "how much
    // cement" can match a chunk about IS 1489 even when the chunk never names the
    // standard. Gemini does this with a native `title` field; OpenAI-compatible
    // endpoints have no equivalent, so the title is prepended to the text instead.
    // nomic-embed-text is prepended too, behind its `search_document:` task prefix.
    prefixTitle: bool('EMBED_PREFIX_TITLE', true),
    batchSize: num('EMBED_BATCH_SIZE', 25),
  },

  /**
   * Local inference via Ollama.
   *
   * `numCtx` is sent on every request rather than left to Ollama's own default,
   * which is chosen from available VRAM and is 4,096 on a machine with no GPU.
   * That matters more than it looks: for models built from the Ollama registry an
   * oversized prompt is *silently* truncated and still answered with HTTP 200, so
   * a missed `num_ctx` produces confident answers built on a third of the
   * evidence with nothing reporting a problem. `OLLAMA_CONTEXT_LENGTH` is set as
   * well so a hand-run `ollama run` behaves the same way, but the request-level
   * value is the one that is guaranteed to apply.
   */
  ollama: {
    baseUrl: str('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
    numCtx: OLLAMA_NUM_CTX,
    // CPU inference on a 2B model is slow but bounded. Generous enough not to
    // cut off a legitimate answer, finite so a wedged request degrades into the
    // existing "generation failed, here are the passages" path instead of hanging.
    timeoutMs: num('OLLAMA_TIMEOUT_MS', 300_000),
  },

  openrouter: {
    apiKey: str('OPEN_ROUTER_API_KEY', ''),
    baseUrl: str('OPEN_ROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  },

  gemini: {
    apiKey: str('GEMINI_API_KEY', ''),
    embedModel: str('GEMINI_EMBED_MODEL', 'gemini-embedding-001'),
    genModel: str('GEMINI_GEN_MODEL', 'gemini-3.6-flash'),
  },

  db: {
    connectionString: str('DATABASE_URL', 'postgres://bis:bis@127.0.0.1:5433/bis_rag'),
  },

  chunk: {
    chars: num('CHUNK_CHARS', 1200),
    overlap: num('CHUNK_OVERLAP', 200),
    // Smallest chunk worth sealing at a clause boundary for. A technical standard
    // is mostly short numbered requirements, and sealing on all of them turned a
    // 929-page document into 7,153 fragments averaging 211 characters — 7,153
    // embedding calls, most too small to retrieve well. The floor is capped at 2%
    // of the document so it stays inert on small inputs, where per-clause
    // citations are exactly what you want.
    minSealChars: num('CHUNK_MIN_SEAL_CHARS', 600),
  },

  retrieval: {
    topK: num('TOP_K', 5),
    /**
     * Token ceiling for the retrieved passages in one generation prompt.
     *
     * Derived rather than guessed: the model window minus the output reserve.
     * This exists because a fixed passage count cannot guarantee a prompt fits.
     * Measured on this corpus, 20 passages average ~757 characters each, so the
     * prompt lands near 6,600 tokens — comfortably inside sarvam-1's 8,192 — but
     * the *longest* passages run to 1,942 characters, and 20 of those reach 15,000
     * tokens and overflow. Average-fits is not the same as always-fits.
     *
     * prompts.js trims the lowest-ranked passages until the prompt provably fits
     * this budget, so the tail sheds its two weakest passages instead of being
     * silently truncated by the server.
     */
    contextTokenBudget: num(
      'CONTEXT_TOKEN_BUDGET',
      Math.max(1024, OLLAMA_NUM_CTX - GEN_MAX_TOKENS - 512)
    ),
    // Corpus- and model-specific, never universal. Both the embedding model and
    // the corpus invalidate any previous measurement, and the ranges are not even
    // similar across models: gemini-embedding-001 put in-corpus pairs at
    // 0.62-0.76 with greetings as high as 0.6056, while lfm-2.5-embedding-350m
    // put the same greetings as low as 0.04. A threshold carried across that
    // change would be meaningless. Measure with `npm run calibrate`.
    threshold: num('SIMILARITY_THRESHOLD', 0.45),
  },

  corpus: {
    pdfDir: path.resolve(process.cwd(), str('PDF_DIR', './data/pdfs')),
    schemaPath: path.resolve(process.cwd(), 'db/schema.sql'),
    // Case-insensitive substrings; a PDF whose basename contains any of them is
    // left out of ingestion. Lets a whole document be parked in the folder
    // without moving files, so it can be switched back on by editing one line.
    exclude: str('PDF_EXCLUDE', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  // pgvector's HNSW/IVFFlat index types refuse to index vectors wider than
  // 2000 dimensions. Refuse a misconfiguration here rather than at index time.
  pgvectorMaxIndexedDims: 2000,
};

export const SUPPORTED_LANGS = ['en', 'hi', 'pa', 'te'];

/** Whether a provider has the credentials it needs to be usable. */
export function providerConfigured(which) {
  if (which === 'openrouter') return Boolean(config.openrouter.apiKey);
  if (which === 'gemini') return Boolean(config.gemini.apiKey);
  // Local inference has no credential to be missing. It was previously falling
  // through to `return false`, which made assertConfig() reject a perfectly valid
  // configuration — a confusing failure for a provider that is ready to use the
  // moment its daemon is running.
  if (which === 'ollama') return true;
  return false;
}

/** The env var a provider needs, for error messages. Null when it needs none. */
function credentialName(which) {
  if (which === 'openrouter') return 'OPEN_ROUTER_API_KEY';
  if (which === 'gemini') return 'GEMINI_API_KEY';
  return null;
}

export function assertConfig() {
  const problems = [];

  if (!providerConfigured(config.generation.provider)) {
    const key = credentialName(config.generation.provider) ?? 'OPEN_ROUTER_API_KEY';
    problems.push(`GEN_PROVIDER=${config.generation.provider} but ${key} is missing. Add it to .env.`);
  }
  if (
    config.generation.fallbackEnabled &&
    config.generation.fallbackProvider &&
    !providerConfigured(config.generation.fallbackProvider)
  ) {
    // Not fatal. A missing fallback only means there is nothing to fall back to.
    console.warn(
      `[config] GEN_FALLBACK_PROVIDER=${config.generation.fallbackProvider} has no API key; ` +
        'generation fallback is disabled.'
    );
    config.generation.fallbackEnabled = false;
  }
  if (!providerConfigured(config.embedding.provider)) {
    const key = credentialName(config.embedding.provider) ?? 'OPEN_ROUTER_API_KEY';
    problems.push(
      `EMBED_PROVIDER=${config.embedding.provider} but ${key} is missing. ` +
        'Embeddings cannot fall back to another provider, so this one is required.'
    );
  }

  for (const [label, provider, allowed] of [
    ['GEN_PROVIDER', config.generation.provider, GEN_PROVIDERS],
    ['GEN_FALLBACK_PROVIDER', config.generation.fallbackProvider, GEN_PROVIDERS],
    ['EMBED_PROVIDER', config.embedding.provider, EMBED_PROVIDERS],
  ]) {
    if (provider && !allowed.includes(provider)) {
      problems.push(`${label}=${provider} is not one of ${allowed.join(', ')}.`);
    }
  }
  if (config.embedding.dims > config.pgvectorMaxIndexedDims) {
    problems.push(
      `EMBED_DIMS=${config.embedding.dims} exceeds the pgvector index limit of ` +
        `${config.pgvectorMaxIndexedDims}. Check the model's native width.`
    );
  }
  if (config.chunk.overlap >= config.chunk.chars) {
    problems.push('CHUNK_OVERLAP must be smaller than CHUNK_CHARS.');
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
