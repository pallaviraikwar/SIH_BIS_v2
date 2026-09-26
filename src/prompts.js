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

export function buildAnswerPrompt({ question, passages, lang = 'en' }) {
  const context = passages
    .map(
      (p, i) =>
        `[${i + 1}] ${p.docTitle}${p.clause ? ` — Clause ${p.clause}` : ''} — page ${p.pageFrom}${
          p.pageTo !== p.pageFrom ? `-${p.pageTo}` : ''
        }\n${p.content}`
    )
    .join('\n\n---\n\n');

  const target = langName(lang);

  return `SOURCE PASSAGES (${passages.length})
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
