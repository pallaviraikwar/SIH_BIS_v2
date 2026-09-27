import express from 'express';
import { answerQuestion } from '../rag.js';
import { SUPPORTED_LANGS } from '../config.js';
import { detectScript } from '../translator.js';

// Multilingual UI strings the frontend does not send us. The answer itself is
// generated in the user's language; these are only the canned replies.
const NO_QUESTION = {
  en: 'Please type a question about a BIS standard.',
  hi: 'कृपया किसी BIS मानक के बारे में प्रश्न लिखें।',
  pa: 'ਕਿਰਪਾ ਕਰਕੇ ਕਿਸੇ BIS ਮਾਪਦੰਡ ਬਾਰੇ ਸਵਾਲ ਲਿਖੋ।',
  te: 'దయచేసి ఏదైనా BIS ప్రమాణం గురించి ప్రశ్న రాయండి.',
};

const ERROR_REPLY = {
  en: 'Something went wrong while answering that. Please try again.',
  hi: 'उत्तर देने में कुछ गड़बड़ हुई। कृपया पुनः प्रयास करें।',
  pa: 'ਜਵਾਬ ਦੇਣ ਵਿੱਚ ਕੁਝ ਗਲਤੀ ਹੋਈ। ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।',
  te: 'సమాధానం ఇవ్వడంలో ఏదో తప్పు జరిగింది. దయచేసి మళ్ళీ ప్రయత్నించండి.',
};

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Work out which language to answer in, and which to word our own errors in.
 *
 * These are two different questions and conflating them is what caused a Hindi
 * question to come back as the single word "नहीं।" with `meta.lang: "en"`:
 *
 *   - `request` is what the caller asked for. The frontend always sends 'auto',
 *     meaning "read the language off the query text". That is not a bug to be
 *     corrected here, it is the whole point of the feature.
 *   - `ui` is a concrete key into the canned copy above, which is indexed by real
 *     language and has no 'auto' entry.
 *
 * The bug specifically: this used to be
 *
 *     const lang = SUPPORTED_LANGS.includes(rawLang) ? rawLang : 'en';
 *
 * 'auto' is deliberately *not* in SUPPORTED_LANGS — that list also feeds
 * normaliseLang() and the i18n table checks, both of which require real
 * languages. So every 'auto' the frontend sent was silently rewritten to 'en'.
 * The downstream guard in rag.js that maps 'auto' to "detect it" therefore never
 * fired over HTTP, and the model was told to reply in English while being handed
 * a Hindi question. Translation still happened, because translation is driven by
 * the script and not by this flag — which is why the symptom was a confidently
 * retrieved answer in the wrong language rather than an obvious failure.
 *
 * Exported for testing: this decision is the thing that broke, and it is pure, so
 * it should not need a model or an HTTP server to verify.
 */
export function resolveLang(rawLang, query) {
  const explicit = SUPPORTED_LANGS.includes(rawLang) ? rawLang : null;

  // 'auto', an absent field, or anything unrecognised all mean the same thing:
  // let the query text decide. Passed through verbatim so rag.js can see the
  // difference between "auto" and an explicit choice.
  const request = explicit ?? 'auto';

  // The canned error copy still needs a real language. Detection is only
  // meaningful when there is text to inspect, so an empty query falls back to
  // English.
  const detected = typeof query === 'string' && query.trim() ? detectScript(query) : 'latin';
  const ui = SUPPORTED_LANGS.includes(detected) ? detected : explicit ?? 'en';

  return { request, ui };
}

export const chatRouter = express.Router();

chatRouter.post('/chat', async (req, res) => {
  const { query, lang: rawLang } = req.body ?? {};

  const { request, ui } = resolveLang(rawLang, query);

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ answer: escapeHtml(NO_QUESTION[ui]) });
  }

  const trimmed = query.trim();
  if (trimmed.length > 2000) {
    return res.status(413).json({
      answer: escapeHtml('Question is too long. Please keep it under 2000 characters.'),
    });
  }

  try {
    const result = await answerQuestion({ query: trimmed, lang: request });
    return res.json(result);
  } catch (err) {
    console.error('[chat] failed:', err);
    return res.status(500).json({ answer: escapeHtml(ERROR_REPLY[ui]) });
  }
});
