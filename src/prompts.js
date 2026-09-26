import { config } from './config.js';
import { langName } from './translator.js';

/**
 * The answer is rendered into the page with innerHTML on a frontend we are not
 * allowed to change, so the model is told to emit plain text plus [[n]] markers
 * and render.js does the escaping and markup. The model never emits HTML.
 */
export const ANSWER_SYSTEM = `You are a precise assistant for Indian Standards (BIS) documents.

You answer questions using ONLY the numbered source passages provided to you. You have no other knowledge of these standards.

ABSOLUTE RULES
1. Use only facts stated in the provided passages. Never add a limit, clause number, value or requirement from your own knowledge, and never guess.
2. If the passages do not contain the answer, reply with exactly this single line and nothing else:
   NOT_FOUND
3. Cite with bracketed numbers that match the passage labels, e.g. [[1]] or [[1]][[3]]. Put the marker immediately after the sentence or clause it supports. Every factual sentence needs a marker.
4. IS numbers, part numbers, years, clause numbers, numeric limits and units must be reproduced exactly as they appear in the passage. Never reformat them.
5. Be concise and direct. No preamble, no "based on the documents", no closing summary, no offers to help further.

OUTPUT FORMAT
Plain text only. No HTML, no markdown, no bullet characters other than "-", no code fences.
A short paragraph or a few "- " lines, with [[n]] citation markers inline.`;

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

export function buildAnswerPrompt({ question, passages, lang = 'en' }) {
  const target = langName(lang);
  const kept = passagesForPrompt({ question, passages, lang });

  // Built from the trimmed list, so the `[n]` labels and the citation
  // instruction stay in agreement. Renumbering after the fact would leave the
  // model citing passage numbers that no longer exist.
  const context = kept.map((p, i) => `${passageLabel(p, i)}\n${p.content}`).join('\n\n---\n\n');

  return `SOURCE PASSAGES (${kept.length})
${context}

---
END OF SOURCE PASSAGES

Question (${target}): ${question}

Answer in ${target}. Keep every IS number, clause number, numeric limit and unit in its original English form regardless of the language you answer in.

Cite using the passage numbers above, like [[1]].`;
}

/**
 * Shown when retrieval found nothing above the relevance bar.
 *
 * Localised as a table, not a bare string. It used to be one English constant
 * plus a second hardcoded English sentence in render.js, so a Hindi or Telugu
 * question that could not be answered was met with an English wall of text in a
 * UI that advertises four languages. Every user-visible string here has to carry
 * all four, and test/i18n.test.js fails the build if one is missing.
 */
export const NOT_FOUND_REPLY = {
  en: 'I could not find an answer to that in the BIS documents loaded into this assistant.',
  hi: 'मुझे इस सहायक में लोड किए गए BIS दस्तावेज़ों में इसका उत्तर नहीं मिला।',
  pa: 'ਮੈਂ ਇਸ ਸਹਾਇਕ ਵਿੱਚ ਲੋਡ ਕੀਤੇ BIS ਦਸਤਾਵੇਜ਼ਾਂ ਵਿੱਚ ਇਸਦਾ ਜਵਾਬ ਨਹੀਂ ਮਿਲਿਆ।',
  te: 'ఈ సహాయకుడిలో లోడ్ చేసిన BIS పత్రాల్లో దీనికి సమాధానం కనిపించలేదు.',
};

/** Second line of the refusal: why it will not fall back to general knowledge. */
export const GROUNDING_NOTE = {
  en: 'The assistant only answers from the BIS documents in its index and will not fall back on general knowledge.',
  hi: 'यह सहायक केवल अपनी सूची में मौजूद BIS दस्तावेज़ों के आधार पर उत्तर देता है; सामान्य ज्ञान का उपयोग नहीं करता।',
  pa: "ਇਹ ਸਹਾਇਕ ਸਿਰਫ਼ ਆਪਣੀ ਸੂਚੀ ਵਿੱਚ ਮੌਜੂਦ BIS ਦਸਤਾਵੇਜ਼ਾਂ ਦੇ ਆਧਾਰ 'ਤੇ ਜਵਾਬ ਦਿੰਦਾ ਹੈ; ਆਮ ਗਿਆਨ ਦੀ ਵਰਤੋਂ ਨਹੀਂ ਕਰਦਾ।",
  te: 'ఈ సహాయకుడు తన జాబితాలో ఉన్న BIS పత్రాల ఆధారంగానే సమాధానాలు ఇస్తుంది; సాధారణ జ్ఞానాన్ని ఉపయోగించదు.',
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
 */
export const GREETING_REPLY = {
  en: 'Hello! Ask me anything about the BIS documents I have loaded, and I will answer with the exact clause and page.',
  hi: 'नमस्ते! मेरे पास लोड किए गए BIS दस्तावेज़ों के बारे में कुछ भी पूछें; मैं सही खंड और पृष्ठ के साथ उत्तर दूँगा।',
  pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੇਰੇ ਕੋਲ ਲੋਡ ਕੀਤੇ BIS ਦਸਤਾਵੇਜ਼ਾਂ ਬਾਰੇ ਕੁਝ ਵੀ ਪੁੱਛੋ; ਮੈਂ ਸਹੀ ਖੰਡ ਅਤੇ ਪੰਨੇ ਨਾਲ ਜਵਾਬ ਦੇਵਾਂਗਾ।',
  te: 'నమస్కారం! నేను లోడ్ చేసిన BIS పత్రాల గురించి ఏదైనా అడగండి; సరైన ఖండం, పేజీతో సమాధానం ఇస్తాను.',
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
