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
    fallbackModel: str('GEN_FALLBACK_MODEL', ''),
    fallbackEnabled: bool('GEN_FALLBACK', false),
    model: str('GEN_MODEL', 'mashriram/sarvam-1'),
    temperature: num('GEN_TEMPERATURE', 0.1),
    // Deliberately well under the model's 8,192-token window. The retrieved
    // passages are not a fixed size — they scale with the document mix and the
    // longest chunk is 1,942 characters — so the output reserve has to leave room
    // for the tail, and prompts.js trims the passages to whatever is left.
    maxOutputTokens: GEN_MAX_TOKENS,
    topP: num('GEN_TOP_P', 0.9),
    // sarvam-1 is a 2.5B model and, left alone, will fall into a repetition loop
    // and emit the same sentence until it exhausts the output budget. Observed
    // directly: "tensile test on steel pipes" produced "The minimum stress
    // required for the pipe to be considered safe for use is recorded." forty
    // times, having quoted no number from the clause it was given. A penalty is
    // the cheapest available fix and costs nothing on a correct answer.
    repeatPenalty: num('GEN_REPEAT_PENALTY', 1.15),
    // How many times one sentence may repeat before the answer is treated as
    // degenerate and thrown away rather than shown to a user.
    maxSentenceRepeats: num('GEN_MAX_SENTENCE_REPEATS', 3),
    // Below this length an answer must share a number or content word with the
    // passages it was given, or it is treated as a non-answer and retried. Set
    // well under a real paragraph so a terse-but-correct "43.0 MPa" still has to
    // be checked on its merits, and well over a bare "No." (4) so that never
    // reaches a user as though a standard had been consulted.
    minSubstantiveChars: num('GEN_MIN_SUBSTANTIVE_CHARS', 40),
    /**
     * Asked to reproduce the answer's opening words.
     *
     * Ollama accepts a trailing assistant turn as a prefix to continue, which
     * forces generation to start on-task instead of restating the instructions.
     * Before this existed the model echoed the system prompt verbatim in roughly
     * 1 run in 7. Setting it is nearly free; leaving it unset is not.
     */
    prefill: str('GEN_PREFILL', 'Answer:'),
  },

  /**
   * Translation. Its own block, deliberately not folded into `generation`.
   *
   * Translating and answering were once the same call. `rag.js` (writing prose) and
   * `translator.js` (converting a Hindi question into an English one) both went
   * through `generateText()`, which hardcodes `config.generation.model` — so both
   * silently used the same 2B chat model. It could not translate: asked to, it
   * answered the question instead. Measured on this corpus, `TRANSLATE_SYSTEM`
   * returned 78% Devanagari and a two-shot English-only variant returned 86%, and
   * the caller reported `translated: true` for both.
   *
   * Separating the two models is not only about quality, it is about memory. The
   * host has 7 GB and no GPU, so what runs simultaneously is a hard constraint:
   * nomic 0.38 GB (embed) + HY-MT 1.1 GB (translate) + sarvam-1 2.67 GB (answer)
   * ≈ 4.1-4.5 GB resident, against 5.21 GB when one model did both jobs. A
   * dedicated translator is cheap enough to leave resident, so the answering model
   * never has to be swapped out to make room.
   *
   * No `fallbackProvider`, unlike `generation`. A fallback *writer* is harmless —
   * the worst case is different prose for the same question — but a fallback
   * *translator* can return a different language entirely, and the retrieval that
   * follows would be wrong in a way no later check could catch. Failing fast into
   * the degraded path is better than a confident mistranslation.
   */
  translation: {
    provider: str('TRANSLATION_PROVIDER', 'ollama'),
    model: str('TRANSLATION_MODEL', 'MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M'),
    /**
     * Send a raw completion prompt instead of a chat message array.
     *
     * HY-MT1.5 is a base model with no chat template. `/api/chat` would wrap the
     * prompt in a chatml template it was never trained on, and the model card
     * specifies a bare completion string, so the two paths are not
     * interchangeable. This stays a flag because the other providers have no raw
     * mode at all — switching TRANSLATION_PROVIDER away from ollama has to keep
     * working, and chat is the only thing they offer.
     */
    raw: bool('TRANSLATION_RAW', true),
    // Greedy. A translation is not a creative task, and any sampling is a chance
    // to drop a standard number on the way through.
    temperature: num('TRANSLATION_TEMPERATURE', 0),
    // A question is one sentence. 256 covers the observed 9-25 token answers with
    // room for a verbose one, and caps the damage if the model ignores the
    // instruction and starts writing prose.
    maxOutputTokens: num('TRANSLATION_MAX_TOKENS', 256),
    /**
     * Not `generation.repeatPenalty` (1.15), and deliberately so.
     *
     * That penalty exists to stop sarvam-1 falling into a repetition loop on a
     * generation task. Here it would work against the requirement: penalising
     * repeated tokens in a faithful translation discourages precisely the repeated
     * standard codes, units and numerals this corpus is made of.
     */
    repeatPenalty: num('TRANSLATION_REPEAT_PENALTY', 1.0),
    /**
     * Not `OLLAMA_TIMEOUT_MS` (300s). A wedged translator should degrade to the
     * "could not translate this" reply within a few seconds, not hold an open HTTP
     * request for five minutes. The answering model is allowed to be slow because
     * it is producing the answer; the translator is on the critical path of every
     * non-English question and is otherwise measured at 0.5-2.8s.
     */
    timeoutMs: num('TRANSLATION_TIMEOUT_MS', 60_000),
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
     * How many of the retrieved passages the *generator* actually reads.
     *
     * Deliberately fewer than `topK`, and the number is measured rather than
     * chosen. Asked to ground in 1 passage, sarvam-1 answers in ~11s and quotes
     * the values in the clause. Asked to ground in 2 it takes ~29s and starts
     * answering from the wrong clause; at 3 it reverts to generic textbook prose.
     * More evidence made this model worse, not better, because it attends to the
     * wrong one of them.
     *
     * Retrieval still returns all `topK` and all of them are shown to the user, so
     * nothing the model could have cited is hidden. Only the count of passages it
     * reads is reduced.
     */
    answerPassages: num('ANSWER_PASSAGES', 1),
    /**
     * Token ceiling for the retrieved passages in one generation prompt.
     *
     * Derived rather than guessed: the model window minus the output reserve.
     * This exists because a fixed passage count cannot guarantee a prompt fits.
     *
     * Note the arithmetic is on `answerTopK` passages, NOT on the 20 candidates
     * `searchChunks` fetches: it over-fetches to rerank, then returns topK, so
     * only topK ever reaches the prompt. At topK=5 with passages averaging 757
     * characters the prompt lands near 2,200 tokens, comfortably inside the
     * 8,192 window. This budget is therefore mostly insurance — it matters if
     * TOP_K is raised, or if the corpus starts producing much longer chunks.
     * The longest chunk in this corpus is 1,942 characters, and five of those
     * would reach ~3,300 tokens, which still fits.
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
    // The top of the three-band scale below, so the default has to agree with it.
    // `softThreshold` and `bridgeFloor` are meaningless if this sits below them.
    threshold: num('SIMILARITY_THRESHOLD', 0.67),

    /**
     * The three-way band below `threshold`.
     *
     * A single cutoff forces a binary decision at a point where the score
     * distributions actually overlap, and the overlap is not academic: on the
     * current corpus, in-corpus questions run 0.677-0.826 while out-of-corpus
     * questions reach 0.708. There is no number that separates them, so anything
     * near the middle is a coin flip decided by a threshold rather than by
     * evidence. Two observed cases made that concrete: "fly ash" scored 0.668 and
     * missed a 0.67 bar by 0.002, while "tell me about the plastics" scored high
     * on nothing at all.
     *
     * So retrieval is no longer cut off in SQL. Everything down to `bridgeFloor`
     * is fetched and banded afterwards:
     *
     *   >= threshold      answer  — the model gets the clause
     *   >= softThreshold  soft    — the model is asked to answer or decline; on
     *                               decline the near-miss is shown as a bridge
     *   >= bridgeFloor    bridge  — "I don't have X, closest is Y, clause Z"
     *   <  bridgeFloor    miss    — echo the query, suggest real corpus topics
     *
     * `softThreshold` is where a genuine attempt starts. It sits above the
     * out-of-corpus median (0.565) and below the in-corpus minimum (0.677), so
     * most real questions reach the model and the refusal band is narrow.
     */
    softThreshold: num('SOFT_THRESHOLD', 0.60),
    /**
     * Below this there is nothing worth bridging to, so the reply stops naming
     * candidate clauses and only suggests topics. Measured out-of-corpus floor on
     * this corpus is 0.466, set just under it so a borderline miss still gets a
     * concrete nearest clause rather than a bare "no".
     */
    bridgeFloor: num('BRIDGE_FLOOR', 0.45),
    /**
     * How many corpus-derived topics a dead-end reply offers. Small enough to
     * read, large enough that one irrelevant suggestion does not decide whether
     * the user thinks the assistant is useless.
     */
    suggestionCount: num('SUGGESTION_COUNT', 6),
    /**
     * How low a similarity can be and still be worth *naming a clause for*.
     *
     * Distinct from `bridgeFloor`, and the gap between the two is the point.
     * `bridgeFloor` (0.45) answers "is there anything at all resembling this?" —
     * everything above it is reachable. This answers the harder question: is this
     * close enough that showing the user the clause helps rather than misleads?
     *
     * Measured out-of-corpus scores on this corpus run 0.466-0.708, so a clause
     * surfaced as "the closest thing I have" can be a coincidence of vocabulary
     * rather than a near miss. Observed directly: "tell me about the plastics"
     * scored 0.5919 and produced cl. 7, *scratch depth 0.255 mm* — a table-scratch
     * requirement, offered as the nearest neighbour to a question about plastic.
     * That is worse than an honest "not covered", because it looks like a finding.
     *
     * So `bridgeFloor` still decides *which band* a result is in — the band is
     * reported in `meta` and by /api/search, and nothing is hidden — while this
     * threshold decides whether the bridge reply quotes the clause. Below it the
     * user still gets a real reply with the question, the corpus coverage and
     * clickable topics, just without a paragraph of unrelated text.
     */
    showNearestFrom: num('SHOW_NEAREST_FROM', 0.6),
    /**
     * Reciprocal-rank-fusion weight for the keyword retriever.
     *
     * Hybrid retrieval runs the vector search and a Postgres full-text search and
     * fuses the two rankings. RRF is used rather than a weighted score sum because
     * cosine similarity and `ts_rank` are not on a comparable scale, so any
     * numeric blend has to be re-tuned whenever either side changes. RRF only
     * depends on rank order, which is stable.
     */
    rrfK: num('RRF_K', 60),
    /**
     * Master switch for the keyword arm. Kept configurable because the FTS index
     * is an extra object in the database: a deployment that has not re-migrated
     * still works with this off, instead of erroring on a missing index.
     */
    hybridSearch: bool('HYBRID_SEARCH', true),
    keywordTopK: num('KEYWORD_TOP_K', 20),
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

/**
 * The languages we can actually *translate into* English.
 *
 * A subset of `SUPPORTED_LANGS`, and the gap is deliberate: Punjabi is a supported
 * interface language but not a translatable one. HY-MT1.5's published language list
 * covers Hindi and Telugu and does not include Gurmukhi, and asking it to anyway
 * does not fail loudly — it invents. Measured on `ਈੱਟ ਬਲਾਕ ਕੀ ਘਣੀ ਹੈ?`
 * ("what is the density of iron?") it returned the fluent, confident and entirely
 * unrelated *"Is it really necessary to have such a complicated system?"*. Zero
 * Devanagari-class characters, so a script check passes it; retrieval then has
 * nothing to work with. Excluding it here means Punjabi text is passed through
 * untranslated instead, which retrieves no better but cannot be blamed on the
 * translator.
 *
 * `SUPPORTED_LANGS` stays the full four because it governs which language the
 * *reply* is written in, and Punjabi questions still get a Punjabi reply — the
 * retrieval behind it is simply the same quality it has always been.
 */
export const TRANSLATABLE_LANGS = ['en', 'hi', 'te'];

/** Whether a detected language can be translated into an English query. */
export function isTranslatable(lang) {
  return TRANSLATABLE_LANGS.includes(lang);
}

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
