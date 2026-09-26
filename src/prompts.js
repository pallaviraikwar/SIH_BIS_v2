import { config } from './config.js';
import { langName } from './translator.js';

/**
 * The answer is rendered into the page with innerHTML on a frontend we are not
 * allowed to change, so the model is told to emit plain text and render.js does
 * the escaping and markup. The model never emits HTML.
 *
 * This used to be fifteen lines of rules and it was actively harmful. sarvam-1 is
 * a 2.5B model: given a long instruction block it would sometimes echo the block
 * back as its answer (observed verbatim: "Answer in English. Keep every IS
 * number, clause number, numeric limit and unit in its original English form...")
 * rather than answering. The same model, given three short rules, answers
 * correctly and quotes the numbers from the passage. Length here is not safety;
 * it is noise the small model latches onto instead of the passages.
 *
 * There is deliberately no "cite with [[n]]" rule any more. sarvam-1 cannot emit
 * citation markers at all: asked for [[1]] it produced none, asked for [1] none,
 * asked for (1) none, asked for P1 none, and on one attempt it spelled out
 * "Passage Number One (SP21 — Clause Eight)" as prose. Four formats, zero
 * markers. Instructing a model to do something it structurally cannot do wastes
 * tokens and invites the "Passage Number One" failure in return. Provenance is
 * carried by the Sources block instead, which is built from the retrieval result
 * and is therefore accurate by construction. render.js still understands [[n]] so
 * a stronger model can be dropped in without touching the frontend.
 */
export const ANSWER_SYSTEM = `Answer using only the numbered passage. Do not use outside knowledge.

If the passage does not answer the question, reply with exactly: NOT_FOUND

Quote numbers, IS codes and units exactly as written. Plain text only, no preamble.`;

/**
 * Roughly how many tokens a string costs.
 *
 * Deliberately the same pessimistic ratio the chunker uses. Erring high here
 * means trimming a passage we could have kept, which costs a little recall;
 * erring low means the prompt overflows, which on a local model means the server
 * quietly discards evidence and answers from half of it.
 */
function estimateTokens(text, charsPerToken = config.embedding.charsPerToken) {
  return Math.ceil(String(text ?? '').length / charsPerToken);
}

/** The per-passage label, which is also its citation number. */
function passageLabel(p, i) {
  return (
    `[${i + 1}] ${p.docTitle}${p.clause ? ` — Clause ${p.clause}` : ''} — page ${p.pageFrom}` +
    `${p.pageTo !== p.pageFrom ? `-${p.pageTo}` : ''}`
  );
}

/**
 * Drop the lowest-ranked passages until the prompt provably fits the window.
 *
 * Why a count cannot do this job: `searchChunks` asks the database for a fixed
 * number of candidates and the passages are not a fixed size. On this corpus
 * they average 757 characters but reach 1,942, so a prompt that comfortably fits
 * with average passages overflows the 8,192-token window with long ones. Because
 * the ordering is by similarity, the passages at the end are the weakest, so they
 * are the ones worth losing.
 *
 * This is also the last line of defence against a genuinely nasty failure mode.
 * Ollama does not reject an oversized prompt for models built from its registry:
 * it trims the input and still answers with HTTP 200, so the model produces a
 * confident answer built on a fraction of the retrieved evidence and no layer of
 * the stack reports anything. `num_ctx` being sent explicitly (see providers/ollama.js)
 * is the primary fix; this is the belt to that braces.
 *
 * At least one passage always survives. Returning zero would turn a successful
 * retrieval into a `NOT_FOUND` answer, which is worse than a short answer: the
 * model would be denying evidence the database actually handed it.
 */
export function fitPassagesToBudget(passages, availableTokens) {
  if (!passages.length) return [];
  const budget = Math.max(availableTokens, 0);

  const kept = [];
  let used = 0;

  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    // Roughly 6 tokens of separator punctuation per passage, plus the label.
    const cost = estimateTokens(passageLabel(p, kept.length) + '\n' + p.content) + 6;

    if (used + cost > budget) break;
    kept.push(p);
    used += cost;
  }

  if (kept.length) return kept;

  // One passage is bigger than the whole budget. Return it truncated rather than
  // returning nothing: a partial clause the model can still cite beats a
  // confident "not found" on a document that is genuinely in the index.
  const first = passages[0];
  const label = passageLabel(first, 0);
  const room = Math.max(0, budget - estimateTokens(label) - 6);
  const clipped = first.content.slice(0, room * config.embedding.charsPerToken);
  console.warn(
    `[prompts] passage 1 alone exceeds the ${budget}-token context budget; ` +
      `truncating it to ${clipped.length} characters.`
  );
  return [{ ...first, content: clipped }];
}

/**
 * The passages that will actually be sent, after charging the fixed prompt cost.
 *
 * Exported so the caller can render the *same* list. If the prompt silently used
 * a subset, the model would cite numbers the user cannot find on screen, and a
 * citation to a passage that is not displayed is indistinguishable from a
 * fabricated one — the single worst outcome this project could produce.
 */
export function passagesForPrompt({ question, passages, lang = 'en' }) {
  const target = langName(lang);
  // Charge the fixed parts of the prompt first, so the budget is spent on
  // evidence rather than on boilerplate. The remainder is deliberately generous
  // for the wrapper text, which is small, fixed, and only has to be roughly right.
  const fixedTokens =
    estimateTokens(ANSWER_SYSTEM) + estimateTokens(`${question} ${target}`) + 120;
  const available = Math.max(512, config.retrieval.contextTokenBudget - fixedTokens);

  const kept = fitPassagesToBudget(passages, available);
  const dropped = passages.length - kept.length;

  if (dropped > 0) {
    console.warn(
      `[prompts] trimmed ${dropped} lowest-ranked passage(s) to fit a ` +
        `${config.retrieval.contextTokenBudget}-token context budget ` +
        `(window ${config.ollama.numCtx} - output ${config.generation.maxOutputTokens}).`
    );
  }
  return kept;
}

/**
 * The opening words the model is required to continue from.
 *
 * Appended to the end of the *user* message. This is the priming trick that
 * works on a 2.5B model: it removes the model's option to start by restating the
 * instructions, which it otherwise does often enough to matter. Before this
 * existed it echoed the system prompt back as its answer, verbatim, in roughly
 * 1 run in 7.
 *
 * It has to be a user-message suffix rather than a trailing assistant turn. Ollama
 * renders a trailing assistant turn through sarvam-1's chatml template, and the
 * model then continues from the template's boundary token and emits a literal
 * "<s>" instead of an answer — verified, not theorised.
 */
export const ANSWER_PREFILL = config.generation.prefill;

export function buildAnswerPrompt({ question, passages, lang = 'en' }) {
  const target = langName(lang);
  const kept = passagesForPrompt({ question, passages, lang });

  // Built from the trimmed list, so the `[n]` labels and the citation
  // instruction stay in agreement. Renumbering after the fact would leave the
  // model citing passage numbers that no longer exist.
  const context = kept
    .map((p, i) => `${passageLabel(p, i)}\n${p.content}`)
    .join('\n\n---\n\n');

  // Short on purpose. The previous version restated the citation format, the
  // language rule and the unit-preservation rule after the passages had already
  // been read, which is a second copy of the system prompt and, on this model,
  // was the text most likely to come back as the answer.
  //
  // "Keep IS codes and numbers in English" is retained from the long version and
  // is not optional for the Indic languages: without it the model renders
  // "IS 14543:2024" as "आईएस 14543:2024", which is a citation the user cannot
  // look up and which silently breaks the traceability this project exists for.
  return `PASSAGE
${context}

Question: ${question}

Answer in ${target}. Keep IS codes and numbers in English.

${ANSWER_PREFILL}`;
}

/**
 * Shown when retrieval found nothing above the relevance bar.
 *
 * Localised as a table, not a bare string. It used to be one English constant
 * plus a second hardcoded English sentence in render.js, so a Hindi or Telugu
 * question that could not be answered was met with an English wall of text in a
 * UI that advertises four languages. Every user-visible string here has to carry
 * all four, and test/i18n.test.js fails the build if one is missing.
 *
 * `{query}` is substituted with the user's own question. This is the single change
 * that turns the refusal from boilerplate into a reply: the previous text was the
 * same sentence for every miss, so a user could not tell a real answer from a
 * canned one, and had no way to learn what the corpus does cover. Naming the query
 * back and following it with topics drawn from the index turns a dead end into a
 * redirect. Anything interpolated is escaped by render.js before it reaches HTML.
 */
export const NOT_FOUND_REPLY = {
  en: 'I do not have anything on "{query}" in the BIS documents loaded here.',
  hi: 'इन लोड किए गए BIS दस्तावेज़ों में मुझे "{query}" के बारे में कुछ नहीं मिला।',
  pa: 'ਇਹ ਲੋਡ ਕੀਤੇ BIS ਦਸਤਾਵੇਜ਼ਾਂ ਵਿੱਚ ਮੈਨੂੰ "{query}" ਬਾਰੇ ਕੁਝ ਨਹੀਂ ਮਿਲਿਆ।',
  te: 'ఇక్కడ లోడ్ చేసిన BIS పత్రాల్లో "{query}" గురించి నాకు ఏమీ దొరకలేదు.',
};

/**
 * Lead-in for a near miss, where the corpus holds something adjacent.
 *
 * Used instead of NOT_FOUND_REPLY when retrieval came back with real but
 * sub-threshold evidence. The distinction is the whole point of the soft and
 * bridge bands: "I have nothing" and "I have something close" are different facts
 * and the user is better served by being told which one is true.
 */
export const NEAR_MISS_LEAD = {
  en: 'I could not find a clause that answers "{query}", but the closest thing I have is below.',
  hi: '"{query}" का उत्तर देने वाला कोई खंड नहीं मिला, लेकिन इसके सबसे नज़दीकी नीचे दिया गया है।',
  pa: 'ਮੈਨੂੰ "{query}" ਦਾ ਜਵਾਬ ਦੇਣ ਵਾਲਾ ਕੋਈ ਖੰਡ ਨਹੀਂ ਮਿਲਿਆ, ਪਰ ਸਭ ਤੋਂ ਨੇੜੇ ਦਾ ਹੇਠਾਂ ਦਿੱਤਾ ਗਿਆ ਹੈ।',
  te: '"{query}" కు సమాధానం ఇచ్చే ఖండం కనబడలేదు, కానీ అతి దగ్గరి ఒకటి కింద ఇవ్వబడింది.',
};

/** Header above the nearest real clause in a bridge reply. */
export const NEAR_MISS_HEADER = {
  en: 'Closest I have:',
  hi: 'सबसे नज़दीकी:',
  pa: 'ਸਭ ਤੋਂ ਨੇੜੇ:',
  te: 'అతి దగ్గరి:',
};

/** Header above the corpus-derived topic suggestions. */
export const SUGGESTIONS_HEADER = {
  en: 'You could ask about:',
  hi: 'आप इनके बारे में पूछ सकते हैं:',
  pa: 'ਤੁਸੀਂ ਇਨ੍ਹਾਂ ਬਾਰੇ ਪੁੱਛ ਸਕਤੇ ਹੋ:',
  te: 'వీటి గురించి అడగవచ్చు:',
};

/** Lead-in for a located entry, when the query was a bare term rather than a question. */
export const LOCATED_LEAD = {
  en: 'Here is what the documents say about "{query}".',
  hi: '"{query}" के बारे में दस्तावेज़ों में यह कहा गया है।',
  pa: '"{query}" ਬਾਰੇ ਦਸਤਾਵੇਜ਼ਾਂ ਵਿੱਚ ਇਹ ਲਿਖਿਆ ਹੈ।',
  te: '"{query}" గురించి పత్రాల్లో ఇది ఉంది.',
};

/** Header above the located entries. */
export const LOCATED_HEADER = {
  en: 'Matching entries:',
  hi: 'मिलते हुए प्रविष्टियाँ:',
  pa: 'ਮਿਲਦੀਆਂ ਐਂਟਰੀਆਂ:',
  te: 'సరిపోలిక ఎంట్రీలు:',
};

/** Second line of the refusal: why it will not fall back to general knowledge. */
export const GROUNDING_NOTE = {
  en: 'Answers come only from the BIS documents in the index, never from general knowledge.',
  hi: 'उत्तर केवल सूची में मौजूद BIS दस्तावेज़ों से दिए जाते हैं; सामान्य ज्ञान का उपयोग नहीं होता।',
  pa: 'ਜਵਾਬ ਸਿਰਫ਼ ਸੂਚੀ ਵਿੱਚ ਮੌਜੂਦ BIS ਦਸਤਾਵੇਜ਼ਾਂ ਤੋਂ ਦਿੱਤੇ ਜਾਂਦੇ ਹਨ; ਆਮ ਗਿਆਨ ਦੀ ਵਰਤੋਂ ਨਹੀਂ ਹੁੰਦੀ।',
  te: 'సమాధానాలు జాబితాలో ఉన్న BIS పత్రాల నుండే ఇస్తుంది; సాధారణ జ్ఞానం నుండి కాదు.',
};

/** Header above the list of documents the corpus actually contains. */
export const COVERAGE_HEADER = {
  en: 'Right now I can answer from these documents:',
  hi: 'मैं इस समय इन दस्तावेज़ों से उत्तर दे सकता हूँ:',
  pa: 'ਇਸ ਵੇਲੇ ਮੈਂ ਇਨ੍ਹਾਂ ਦਸਤਾਵੇਜ਼ਾਂ ਤੋਂ ਜਵਾਬ ਦੇ ਸਕਦਾ ਹਾਂ:',
  te: 'ప్రస్తుతం నేను ఈ పత్రాల నుండి సమాధానాలు ఇవ్వగలను:',
};

/**
 * Shown for greetings, thanks and similar non-questions.
 *
 * The alternative was answering "hi" with a paragraph retrieved at 0.6056
 * similarity, so this is not politeness — it is the only correct answer.
 *
 * It deliberately no longer promises an exact clause and page. sarvam-1 does not
 * reliably ground: asked about Indian bricks it cited "BS EN1985-2017", a British
 * standard that is not in this corpus at all. Promising traceability the
 * generator cannot deliver is worse than promising nothing, because a user who
 * trusts the promise has no reason to check the Sources block. The real coverage
 * list and real topics are appended below this line, so the reply is specific
 * anyway.
 */
export const GREETING_REPLY = {
  en: 'Hello. Ask me about the documents listed below and I will answer from them, with the sources shown.',
  hi: 'नमस्ते। नीचे सूचीबद्ध दस्तावेज़ों के बारे में पूछें; मैं उन्हीं के आधार पर उत्तर दूँगा और स्रोत भी दिखाऊँगा।',
  pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ। ਹੇਠਾਂ ਦਿੱਤੀ ਦਸਤਾਵੇਜ਼ਾਂ ਬਾਰੇ ਪੁੱਛੋ; ਮੈਂ ਉਨ੍ਹਾਂ ਹੀ ਤੋਂ ਜਵਾਬ ਦੇਵਾਂਗਾ ਅਤੇ ਸਰੋਤ ਵੀ ਦਿਵਾਂਗਾ।',
  te: 'నమస్కారం. కింద జాబితా చేసిన పత్రాల గురించి అడగండి; నేను వాటి నుండే సమాధానం ఇస్తాను, మూలాలతో సహా.',
};

/**
 * Shown when a non-English question could not be translated into English.
 *
 * The corpus is English-only, so an untranslated Hindi or Telugu query would be
 * embedded in its own script and matched against English technical text. The
 * embedding model is multilingual enough to return *something*, which is the
 * problem: the user would get a confident answer built on a retrieval that was
 * never really on-topic, with nothing in the response to say so. Saying "I could
 * not process that" costs the user one retry and is worth it.
 */
export const TRANSLATION_FAILED_REPLY = {
  en: 'I could not translate your question into English just now, and this assistant only searches English BIS documents. Please try again in a moment, or ask in English.',
  hi: 'मैं अभी आपके प्रश्न का अंग्रेज़ी में अनुवाद नहीं कर पाया, और यह सहायक केवल अंग्रेज़ी BIS दस्तावेज़ों में खोज करता है। कृपया कुछ देर बाद पुनः प्रयास करें, या अंग्रेज़ी में पूछें।',
  pa: 'ਮੈਂ ਹੁਣ ਤੁਹਾਡੇ ਸਵਾਲ ਦਾ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ ਅਨੁਵਾਦ ਨਹੀਂ ਕਰ ਸਕਿਆ, ਅਤੇ ਇਹ ਸਹਾਇਕ ਸਿਰਫ਼ ਅੰਗਰੇਜ਼ੀ BIS ਦਸਤਾਵੇਜ਼ਾਂ ਵਿੱਚ ਖੋਜਦਾ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ, ਜਾਂ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ ਪੁੱਛੋ।',
  te: 'మీ ప్రశ్నను ఇప్పటికే ఆంగ్లంలో అనువదించలేకపోయాను, మరియు ఈ సహాయకుడు ఆంగ్ల BIS పత్రాలలో మాత్రమే వెతుకుతుంది. దయచేసి కొద్ది సేపటి తర్వాత మళ్లీ ప్రయత్నించండి, లేదా ఆంగ్లంలో అడగండి.',
};

/**
 * Shown when retrieval succeeded but the model call itself failed (outage, 503,
 * quota). Kept separate from NOT_FOUND_REPLY on purpose: the corpus *does* have
 * relevant text, so we must not imply the question was unanswerable.
 */
export const GENERATION_FAILED_REPLY = {
  en: 'I found relevant passages in the BIS documents, but I could not generate an answer just now. Please try again in a moment — the source passages are shown below.',
  hi: 'मुझे BIS दस्तावेजों में प्रासंगिक अनुच्छेद मिले हैं, लेकिन अभी उत्तर तैयार नहीं कर पाया। कृपया कुछ देर बाद पुनः प्रयास करें — स्रोत अनुच्छेद नीचे दिए गए हैं।',
  pa: 'ਮੈਂ BIS ਦਸਤਾਵੇਜ਼ਾਂ ਵਿੱਚ ਸੰਬੰਧਿਤ ਅਨੁਕੂਲਾਂ ਲੱਭੀਆਂ, ਪਰ ਹੁਣ ਜਵਾਬ ਨਹੀਂ ਬਣਾ ਸਕਿਆ। ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ — ਸਰੋਤ ਅਨੁਕੂਲਾਂ ਹੇਠਾਂ ਦਿੱਤੀਆਂ ਗਈਆਂ ਹਨ।',
  te: 'నేను BIS పత్రాలలో సంబంధిత అనుకూలాలను కనుగొన్నాను, కానీ ఇప్పటికే సమాధానం రూపొందించలేకపోయాను. దయచేసి కొద్ది సేపటి తర్వాత మళ్లీ ప్రయత్నించండి — మూల అనుకూలాలు కింద చూపబడ్డాయి.',
};
