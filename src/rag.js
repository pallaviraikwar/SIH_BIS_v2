import { config } from './config.js';
import { embedQuery, generateText } from './providers/index.js';
import { searchChunks, listDocumentTitles, retrieveHybrid, corpusTopics, rotateTopics, parseIsIdentifier, passageHasIdentifier } from './store.js';
import { normaliseLang, toEnglishQuery } from './translator.js';
import { ANSWER_SYSTEM, buildAnswerPrompt, passagesForPrompt, GENERATION_FAILED_REPLY } from './prompts.js';
import {
  renderAnswerHtml,
  renderSourcesHtml,
  renderNotFoundHtml,
  renderNearMissHtml,
  renderLocatedHtml,
  renderGreetingHtml,
  renderTranslationFailedHtml,
  escapeHtml,
  modelSaysNotFound,
} from './render.js';
import { detectIntent } from './intent.js';

const ms = (start) => `${Date.now() - start}ms`;

/**
 * Translation facts, spread into every `meta` block.
 *
 * Declared once because there are five return paths and they all report the same
 * three things, and a diagnostic that can tell you *that a translation happened*
 * but not *whether it was any good* is the diagnostic that let the original bug
 * through: `translationUsed: true` was reported on 86%-Devanagari output, so every
 * successful-looking Hindi request in the logs was actually mistranslated.
 *
 * `translationSuspect` is the field that would have caught it. It is true when the
 * translator returned English but something was off — romanised Hindi left in the
 * text, or a standard code that did not survive. The answer is still served,
 * because a `suspect` verdict is a heuristic rather than a hard failure, but it is
 * recorded on every path so a pattern is visible in logs instead of being tolerated.
 */
const translationMeta = (t) => ({
  translationUsed: t.translated,
  ...(t.suspect ? { translationSuspect: true, translationWarnings: t.translationWarnings ?? [] } : {}),
});

/**
 * Whether an answer has collapsed into a repetition loop.
 *
 * `repeat_penalty` reduces the chance of this happening, but a 2.5B model on CPU
 * still finds the corners, and shipping one to a user is much worse than saying
 * nothing. Measured on this setup before the penalty was added: "tensile test on
 * steel pipes" returned "The minimum stress required for the pipe to be
 * considered safe for use is recorded." forty times while quoting no value from
 * the clause it had been handed.
 *
 * Detected structurally rather than by comparing against a known answer: split on
 * sentence boundaries and look for any single sentence occurring more times than
 * `maxSentenceRepeats`. That catches the pathological case — one sentence filling
 * the whole budget — without punishing a legitimately repetitive answer, which
 * would repeat *several* sentences a few times each rather than one sentence many
 * times.
 */
export function isDegenerate(text, maxRepeats = config.generation.maxSentenceRepeats) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 120) return false; // too short to loop meaningfully

  const sentences = trimmed
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  if (sentences.length < 2) return false;

  const counts = new Map();
  for (const s of sentences) {
    // Normalise so "is recorded." and "is recorded" count as one sentence.
    const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const n = (counts.get(key) ?? 0) + 1;
    if (n > maxRepeats) return true;
    counts.set(key, n);
  }
  return false;
}

/**
 * Whether an answer carries any of the evidence it was handed.
 *
 * `isDegenerate` catches repetition loops and deliberately ignores text under 120
 * characters, because you cannot loop meaningfully in 119 of them. That leaves the
 * opposite failure open, and it is the one users actually reported: the model
 * returns a short non-answer and it is served as a confident, fully cited reply.
 *
 * Measured, on a Hindi question about ready-mixed paints. Retrieval was perfect —
 * band=answer, topSimilarity 0.7694, five real clauses from SP 21 p. 827 — and the
 * model replied "नहीं।" The whole response was four characters and a Sources block
 * implying the standard had been consulted. The 120-character floor meant the
 * quality gate waved it through, and `notFound` was false, so nothing downstream
 * could tell it apart from a real answer.
 *
 * Length alone is the wrong test. A terse "43.0 MPa" is a complete and correct
 * answer to a strength question, and rejecting it would be worse than the bug. So
 * the question asked here is not "is it long" but "is any of it traceable to the
 * passages" — a number or a content word that also occurs in the evidence. A bare
 * "No." shares nothing with the paint clauses and fails; "43.0 MPa" shares 43.0
 * with the cement clause and passes.
 *
 * A lookup fragment ("IS 456", "fly ash") is exempt: its whole answer is expected
 * to be a number, and the passages are the authority rather than the source of
 * vocabulary.
 */
export function isSubstantive(answer, passages) {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!text) return false;
  if (text.length >= config.generation.minSubstantiveChars) return true;

  // Numbers are the payload of nearly every answer this corpus can give, so a
  // shared figure is strong evidence the model read the clause. Compared as bare
  // digit runs to survive the units and punctuation the model chooses.
  const digits = text.match(/\d+(?:\.\d+)?/g) ?? [];
  const evidence = (Array.isArray(passages) ? passages : [])
    .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
    .join('\n');
  if (!evidence) return false;
  if (digits.some((d) => evidence.includes(d))) return true;

  // Otherwise fall back to shared content words. Stopwords are excluded because
  // "the" and "shall" are in every clause in the index and would make this pass
  // for literally any reply.
  const words = new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
  );
  if (words.size === 0) return false;
  const haystack = evidence.toLowerCase();
  for (const w of words) {
    if (haystack.includes(w)) return true;
  }
  return false;
}

const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which', 'when', 'where',
  'does', 'will', 'shall', 'must', 'should', 'could', 'would', 'from', 'with', 'have',
  'been', 'were', 'they', 'them', 'then', 'than', 'into', 'about', 'your', 'their',
  'answer', 'question', 'sorry', 'cannot', 'unable', 'sorry', 'specified', 'given',
  'following', 'above', 'below', 'otherwise', 'however', 'therefore', 'because',
]);

/**
 * Titles of the indexed documents, for scope-aware replies.
 *
 * Fetched only when a reply actually needs it. It costs one cheap indexed query
 * and must never be able to fail a request, so any error degrades to an empty
 * list — the reply simply omits the coverage section.
 */
async function coverageTitles() {
  try {
    return await listDocumentTitles();
  } catch (err) {
    console.error(`[rag] could not list documents for scope message: ${err.message}`);
    return [];
  }
}

/**
 * Real topics from the corpus, for a reply that cannot answer.
 *
 * Seeded from the user's own query so the same question always offers the same
 * suggestions (stable under refresh) while different questions surface different
 * parts of the index. Like coverageTitles, it must never be able to fail a
 * request: an empty list simply means the reply omits the section.
 */
async function suggestTopics(query) {
  try {
    return rotateTopics(await corpusTopics(), query ?? '');
  } catch (err) {
    console.error(`[rag] could not derive topic suggestions: ${err.message}`);
    return [];
  }
}

/**
 * Where a retrieval result sits on the answer / soft / bridge / miss scale.
 *
 * A single cutoff forced a binary decision in a place where the two distributions
 * genuinely overlap: in-corpus questions measure 0.677-0.826 while out-of-corpus
 * questions reach 0.708, so no number separates them and every threshold near the
 * middle is a coin flip. The consequences were visible and silly — "fly ash" scored
 * 0.668 and was refused by 0.002, while "tell me about the plastics" cleared the
 * bar with nothing behind it.
 *
 * Four bands let the retrieval be wrong gracefully instead of binary:
 *
 *   answer  the clause is on topic, hand it to the model
 *   soft    plausible but not convincing; let the model try, and if it declines
 *           show the near miss rather than a bare refusal
 *   bridge  too weak to answer from, close enough to name as the closest thing
 *   miss    nothing resembles it, so stop pretending and redirect
 */
export function bandFor(topSimilarity) {
  if (topSimilarity >= config.retrieval.threshold) return 'answer';
  if (topSimilarity >= config.retrieval.softThreshold) return 'soft';
  if (topSimilarity >= config.retrieval.bridgeFloor) return 'bridge';
  return 'miss';
}

/**
 * Whether the query is a bare term to look up rather than a question to answer.
 *
 * Observed failure this prevents: "fly ash" retrieves the correct entry (cl. 1.12,
 * p. 24) and the generator, asked to answer it, returned the literal string "Fly
 * Ash" — the heading, copied back. Five seconds of CPU to tell the user the two
 * words they had already typed, delivered on the success path with a full Sources
 * block, so it read as a real answer.
 *
 * The test is lexical rather than clever: a short query that contains no
 * interrogative and no request verb. "fly ash", "IS 456" and "waterproofing" are
 * lookups; "what is fly ash" and "tell me about fly ash" are questions, and go to
 * the model. Capping the word count matters because a long query without a question
 * mark ("the compressive strength of concrete per IS code") is still a question,
 * and a three-word one that starts with a request verb is too.
 */
const REQUEST_VERBS =
  /^(what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|shall|tell|explain|describe|define|list|give|show|find|search|summar|summari|write|provide|need|want)\b/i;

export function isLookupFragment(query) {
  const q = String(query ?? '').trim();
  if (!q) return false;

  // An "IS <code>" query is a lookup by definition. This has to be tested before
  // the request-verb rule below, because "IS 456" begins with "is" and would
  // otherwise be classified as the question "is 456 ...".
  if (/^is\s*:?\s*\d/i.test(q)) return true;

  if (REQUEST_VERBS.test(q)) return false;

  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;

  // A question mark only signals a question when there is something around it.
  // "bricks?" is one word with a trailing question mark — someone poking at the
  // assistant, not asking for something — and it retrieves perfectly well on its
  // own, so treating it as a question would send a lookup to the generator.
  if (q.includes('?') && words.length > 1) return false;

  return true;
}

/**
 * Full pipeline: translate -> retrieve -> ground -> render.
 *
 * The original-language question is what the user is answered against, while
 * the English translation is what gets embedded. Answering in the requested
 * language from English context avoids the drift you get from generating in
 * English and then machine-translating the result.
 */
export async function answerQuestion({ query, lang: rawLang }) {
  const requested = normaliseLang(rawLang === 'auto' ? null : rawLang);
  const t0 = Date.now();

  // Greetings are handled before anything costs money. "hi" is the worst case for
  // a similarity threshold — it embeds near the centroid of generic prose and
  // scores 0.6056, above the configured bar — so retrieving for it produces a
  // confident answer about committee procedure to someone who just said hello.
  const intent = detectIntent(query);
  if (intent === 'chitchat') {
    const [titles, topics] = await Promise.all([coverageTitles(), suggestTopics(query)]);
    return {
      answer: renderGreetingHtml({ lang: requested, coverageTitles: titles, topics }),
      sources: [],
      notFound: false,
      meta: {
        lang: requested,
        intent,
        translationUsed: false,
        retrievalQuery: query,
        retrieved: 0,
        notFound: false,
        timings: { translate: '0ms', retrieve: '0ms', generate: '0ms' },
        total: ms(t0),
      },
    };
  }

  // `requested` is only ever an explicit override; when the client sends 'auto' it
  // is null, and the translator takes the language from the query text itself. That
  // inversion is the fix for the original bug: `lang` used to gate translation, so a
  // Hindi question sent with the default `lang: 'en'` was never translated and the
  // raw Devanagari was embedded directly.
  const translation = await toEnglishQuery(query, rawLang);
  const tTranslate = Date.now() - t0;

  // The reply is written in the language the question was asked in, detected or
  // overridden, rather than in whatever the request happened to say.
  const lang = translation.lang ?? requested;

  // A non-English question we could not translate is not a question we can
  // answer honestly. Embedding it in its own script would still return matches —
  // the model is multilingual — so the failure would be invisible and the user
  // would get a confident answer to a retrieval that was never on-topic.
  if (translation.error) {
    return {
      answer: renderTranslationFailedHtml({ lang }),
      sources: [],
      notFound: false,
      meta: {
        lang,
        intent: 'question',
        translationUsed: false,
        translationFailed: true,
        retrievalQuery: null,
        retrieved: 0,
        notFound: false,
        degraded: true,
        reason: 'translation_failed',
        detail: translation.error,
        timings: { translate: tTranslate, retrieve: '0ms', generate: '0ms' },
        total: ms(t0),
      },
    };
  }

  const t1 = Date.now();
  const queryVector = await embedQuery(translation.text);
  // Hybrid: the vector arm plus a keyword arm, fused. Replaces a direct
  // `searchChunks` call so misspellings and bare IS codes can be rescued before
  // banding. Banding is on the true cosine similarity of whatever comes back, so
  // the keyword arm can change *which* chunks are considered without being able to
  // inflate a score past the calibrated threshold.
  let passages = await retrieveHybrid({
    embedding: queryVector,
    text: translation.text,
    topK: config.retrieval.topK,
  });
  const tRetrieve = Date.now() - t1;

  const topSimilarity = passages[0]?.similarity ?? 0;
  let band = bandFor(topSimilarity);

  /**
   * An identifier the passage actually prints outranks the similarity score.
   *
   * A bare "IS 456" embeds at 0.546 and lands in the bridge band, which is
   * technically correct — the vector genuinely does not know what the user meant —
   * and practically wrong, because the corpus contains the clause that defines
   * IS 456 and the user is asking for exactly that. Cosine similarity is the right
   * measure of topical relatedness and the wrong measure of "did you find the thing
   * I named".
   *
   * The promotion is deliberately narrow, and gated on the passage containing the
   * identifier rather than on a keyword score. A common word like "water" matches
   * thousands of chunks through the text index; requiring that the digits of the
   * queried code actually appear in the returned passage means this can only fire
   * on a real identifier hit. Everything else still has to earn its band on cosine.
   */
  const identifier = parseIsIdentifier(translation.text) ?? parseIsIdentifier(query);
  if (band !== 'answer' && identifier) {
    const hit = passages.find((p) => passageHasIdentifier(p, identifier));
    if (hit) {
      // Promote to 'soft', never straight to 'answer': the model still has to
      // confirm the clause says what the user asked, because a chunk can mention
      // an identifier without being about it.
      band = 'soft';
      if (passages[0] !== hit) {
        passages = [hit, ...passages.filter((p) => p !== hit)].slice(0, config.retrieval.topK);
      }
    }
  }

  // `miss` and `bridge` are answered without calling the model. There is no
  // grounded answer to be had, and a model handed thin context will cheerfully
  // invent one — the observed failure being a British standard cited for a question
  // about Indian bricks. Both still answer the user, just with the evidence that
  // does exist rather than a canned sentence.
  if (band === 'miss' || band === 'bridge') {
    const [titles, topics] = await Promise.all([coverageTitles(), suggestTopics(query)]);

    if (band === 'miss') {
      return {
        answer: renderNotFoundHtml({ lang, query, coverageTitles: titles, topics }),
        sources: [],
        notFound: true,
        meta: {
          lang,
          translationUsed: translation.translated,
          ...translationMeta(translation),
          retrievalQuery: translation.text,
          retrieved: 0,
          notFound: true,
          band,
          reason: 'nothing_above_bridge_floor',
          timings: { translate: tTranslate, retrieve: tRetrieve, generate: '0ms' },
          topSimilarity: Number(topSimilarity.toFixed(4)),
          thresholds: thresholds(),
          total: ms(t0),
        },
      };
    }

    // Whether the bridge reply is allowed to *name* a clause. The band itself is
    // unaffected and still reported, because suppressing the clause must not hide
    // that it was found and rejected — that is the information a person tuning the
    // thresholds actually needs.
    //
    // Measured: out-of-corpus questions on this corpus run 0.466-0.708, so a
    // "closest thing I have" offered from inside that range is a coincidence rather
    // than a near miss. The observed case was a question about plastics scoring
    // 0.5919 and being answered with a table-scratch requirement, which reads as a
    // finding and is worse than an honest gap. Above the floor the clause is shown;
    // below it the user gets the same reply without the unrelated paragraph, and
    // `renderNearMissHtml` handles a null `nearest` on its own.
    const showNearest = topSimilarity >= config.retrieval.showNearestFrom;

    return {
      answer: renderNearMissHtml({
        lang,
        query,
        nearest: showNearest ? passages[0] : null,
        coverageTitles: titles,
        topics,
      }),
      sources: [],
      notFound: true,
      meta: {
        lang,
        translationUsed: translation.translated,
        ...translationMeta(translation),
        retrievalQuery: translation.text,
        retrieved: 0,
        notFound: true,
        band,
        reason: showNearest ? 'only_near_misses' : 'too_weak_to_quote',
        // Surfaced so the suppression is auditable rather than mysterious: a user
        // reporting "it said it found nothing but the score was 0.55" can see that
        // the clause was found and deliberately not quoted.
        nearestSuppressed: !showNearest,
        timings: { translate: tTranslate, retrieve: tRetrieve, generate: '0ms' },
        topSimilarity: Number(topSimilarity.toFixed(4)),
        thresholds: thresholds(),
        total: ms(t0),
      },
    };
  }

  // A bare term is a lookup, not a question, so it gets located instead of
  // answered. Checked after banding so a fragment that matches nothing still
  // produces the ordinary miss reply, which is the more useful of the two.
  if ((band === 'answer' || band === 'soft') && isLookupFragment(query)) {
    const [titles, topics] = await Promise.all([coverageTitles(), suggestTopics(query)]);
    return {
      answer: renderLocatedHtml({
        lang,
        query,
        passages: passages.slice(0, 3),
        coverageTitles: titles,
        topics,
      }),
      sources: passages.slice(0, 3).map(publicSource),
      notFound: false,
      meta: {
        lang,
        translationUsed: translation.translated,
        ...translationMeta(translation),
        retrievalQuery: translation.text,
        retrieved: Math.min(3, passages.length),
        notFound: false,
        band: 'located',
        reason: 'lookup_fragment',
        timings: { translate: tTranslate, retrieve: tRetrieve, generate: '0ms' },
        topSimilarity: Number(topSimilarity.toFixed(4)),
        thresholds: thresholds(),
        total: ms(t0),
      },
    };
  }

  const t2 = Date.now();

  // Decided once, then used for the prompt *and* the rendered sources. If the
  // prompt quietly received a subset, the model would cite `[n]` markers the user
  // cannot find on screen, and a citation to a passage that is not shown is
  // indistinguishable from an invented one.
  //
  // Only the passages the model actually reads are trimmed down
  // (`answerPassages`); the full ranked list is still shown to the user. Showing
  // more than was used is safe — the invariant that matters is that nothing cited
  // is hidden, not that nothing extra is visible.
  const answerInput = passages.slice(0, config.retrieval.answerPassages);
  const usedPassages = passagesForPrompt({ question: query, passages: answerInput, lang });

  let answerText;
  let genProvider = null;
  let genDegraded = false;
  let generateError = null;
  let degenerate = false;
  try {
    const prompt = buildAnswerPrompt({ question: query, passages: usedPassages, lang });

    // One retry, for an answer that is unusable rather than for a failed request.
    // Both a repetition loop and a content-free non-answer mean the model did
    // return text, so re-asking is meaningful; a request that throws is a
    // different question and must not be retried here.
    //
    // A lookup fragment is exempt from the substance check. "IS 456" is answered
    // with the standard's title, and "fly ash" with a bare figure, and in both
    // cases a short reply is the correct shape of the answer rather than a defect.
    const exempt = isLookupFragment(query);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const gen = await generateText({
        systemInstruction: ANSWER_SYSTEM,
        prompt,
        // Only the retry runs warmer. Re-running the same decode at the same
        // temperature on the same prompt tends to reproduce the same loop.
        temperature: attempt === 2 ? Math.max(config.generation.temperature, 0.4) : undefined,
      });
      answerText = gen.text;
      genProvider = gen.provider;
      genDegraded = gen.degraded;

      const looped = isDegenerate(answerText);
      const empty = !exempt && !isSubstantive(answerText, usedPassages);
      if (!looped && !empty) break;

      degenerate = true;
      if (attempt === 1) {
        console.warn(
          empty
            ? `[rag] model returned a non-answer (${JSON.stringify(
                String(answerText ?? '').slice(0, 60)
              )}); retrying once at a higher temperature`
            : '[rag] model produced a repetition loop; retrying once at a higher temperature'
        );
        continue;
      }
      console.error(
        empty
          ? '[rag] non-answer survived the retry; discarding it rather than showing an empty reply with citations'
          : '[rag] repetition loop survived the retry; discarding the answer'
      );
      answerText = null;
    }
  } catch (err) {
    generateError = err;
    console.error(`[rag] generation failed: ${err.message}`);
  }
  const tGenerate = Date.now() - t2;

  // Generation failing is not a 500: the retrieved evidence is still worth
  // showing, so degrade to a retryable notice plus the passages.
  //
  // This is deliberately NOT the "not found" copy. That message tells the user
  // the corpus has nothing, which is false here — retrieval succeeded and we are
  // holding real clauses. Telling someone their question is unanswerable when the
  // real problem is a model outage sends them off to rephrase a question that was
  // fine. The raw error goes to the log, not into the response body.
  if (generateError || !answerText) {
    return {
      answer:
        `<p style="margin:0 0 8px">${escapeHtml(GENERATION_FAILED_REPLY[lang] ?? GENERATION_FAILED_REPLY.en)}</p>` +
        renderSourcesHtml(passages, lang, usedPassages.length),
      sources: usedPassages.map(publicSource),
      notFound: false,
      degraded: true,
      meta: {
        lang,
        translationUsed: translation.translated,
        ...translationMeta(translation),
        retrievalQuery: translation.text,
        retrieved: usedPassages.length,
        notFound: false,
        degraded: true,
        band,
        reason: generateError ? 'generation_failed' : 'generation_degenerate',
        timings: { translate: tTranslate, retrieve: tRetrieve, generate: tGenerate },
        topSimilarity: Number(topSimilarity.toFixed(4)),
        thresholds: thresholds(),
      },
    };
  }

  return {
    answer: renderAnswerHtml({
      answerText,
      passages,
      lang,
      coverageTitles: await coverageTitles(),
      passedToModel: usedPassages.length,
      query,
      topics: await suggestTopics(query),
    }),
    sources: usedPassages.map(publicSource),
    answerText,
    notFound: modelSaysNotFound(answerText),
    meta: {
      lang,
      translationUsed: translation.translated,
      ...translationMeta(translation),
      retrievalQuery: translation.text,
      retrieved: usedPassages.length,
      // Which model actually answered. A fallback answer is still correct, but
      // it is not the configured model, and a support report that says the local
      // model is down when a hosted one answered is worth catching here.
      generationProvider: genProvider,
      generationDegraded: genDegraded,
      // True when the first attempt looped and the retry produced this answer.
      // Worth surfacing: a question that needs the warm retry every time is a
      // question sitting near the edge of what the model can do.
      generationDegenerateFirstTry: degenerate,
      band,
      timings: { translate: tTranslate, retrieve: tRetrieve, generate: tGenerate },
      topSimilarity: Number(topSimilarity.toFixed(4)),
      thresholds: thresholds(),
      total: ms(t0),
    },
  };
}

/**
 * Retrieval-only path, for the /api/search debug endpoint. No model call.
 *
 * Uses the same hybrid retrieval and reports the band, so the debug endpoint shows
 * what the answer path would have decided instead of a filtered list that hides
 * the near misses entirely.
 */
export async function searchOnly(query, { topK, threshold, lang } = {}) {
  // Previously hardcoded to 'en' here, which was the same bug as in
  // `answerQuestion`: a non-English query was never translated, so the sidebar
  // search box embedded raw Devanagari into an English-only model and reported the
  // result as the answer-path decision. It was invisible because /api/search took
  // no `lang` at all, so there was no way to ask the question that would have
  // exposed it. `lang` is now accepted, and defaults to auto-detection, so this
  // path and the chat path cannot disagree about what a query means.
  const translation = await toEnglishQuery(query, lang);
  const vector = await embedQuery(translation.text);

  const passages = await retrieveHybrid({
    embedding: vector,
    text: translation.text,
    topK: topK ?? config.retrieval.topK,
  });

  // An explicit threshold means the caller wants a filtered view (the Quick
  // Directory search), so honour it here rather than reporting the whole band.
  const filtered =
    threshold === undefined
      ? passages
      : passages.filter((p) => p.similarity >= threshold);

  return {
    query: translation.text,
    originalQuery: query,
    lang: translation.lang,
    translated: translation.translated,
    passages: filtered,
    allPassages: passages,
    topSimilarity: Number((passages[0]?.similarity ?? 0).toFixed(4)),
    band: bandFor(passes[0]?.similarity ?? 0),
  };
}

function publicSource(p) {
  return {
    docTitle: p.docTitle,
    clause: p.clause,
    pages: p.pageFrom === p.pageTo ? [p.pageFrom] : [p.pageFrom, p.pageTo],
    similarity: Number(p.similarity.toFixed(4)),
  };
}

function escapeForHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The band boundaries in force for a request, so a report can be reproduced. */
function thresholds() {
  return {
    answer: config.retrieval.threshold,
    soft: config.retrieval.softThreshold,
    bridge: config.retrieval.bridgeFloor,
    // Not a band boundary — it decides whether the bridge reply quotes the clause.
    // Reported here so a suppressed near miss is distinguishable from a lost one.
    showNearestFrom: config.retrieval.showNearestFrom,
  };
}
