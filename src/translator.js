import { generateText } from './gemini.js';
import { SUPPORTED_LANGS } from './config.js';

const LANG_NAMES = {
  en: 'English',
  hi: 'Hindi (Devanagari)',
  pa: 'Punjabi (Gurmukhi)',
  te: 'Telugu',
};

export function normaliseLang(lang) {
  return SUPPORTED_LANGS.includes(lang) ? lang : 'en';
}

export function langName(lang) {
  return LANG_NAMES[normaliseLang(lang)];
}

/**
 * Rough script detection, used only to skip pointless translation calls.
 *
 * Devanagari, Gurmukhi and Telugu all sit in the Basic Multilingual Plane, so
 * counting non-ASCII code points is a good enough proxy: an English query
 * returns false and never costs a model call.
 */
export function looksNonLatin(text) {
  const sample = text.slice(0, 400);
  if (!sample) return false;
  let nonAscii = 0;
  for (const ch of sample) {
    if (ch.codePointAt(0) > 0x00ff) nonAscii++;
  }
  return nonAscii / sample.length > 0.15;
}

const TRANSLATE_SYSTEM = `You are a translation engine for technical questions about Indian Standards (BIS/IS codes).

Translate the user's question into clear technical English.

Rules:
- Keep every standard designation verbatim: IS numbers, part numbers, years and clause numbers must NOT be translated or reformatted (write "IS 14543", never "आईएस 14543" and never "IS-14543-2024").
- Keep numeric limits, units and symbols exactly as written (6.0%, 43.0 MPa, 2000 mg/l).
- Keep product and material names in English if that is the term of art.
- Use natural English, not transliterated speech.
- Output ONLY the translated question. No preamble, no quotes, no explanation.`;

/**
 * Translate the incoming question into English for retrieval.
 *
 * The corpus is English-only (BIS standards are published in English), so a
 * Hindi or Telugu question is embedded in English. This measurably beats
 * embedding the native-language question directly against English chunks.
 * Queries already in Latin script skip the call entirely.
 */
export async function toEnglishQuery(query, lang) {
  if (lang === 'en' || !looksNonLatin(query)) return { text: query, translated: false };

  try {
    const text = await generateText({
      systemInstruction: TRANSLATE_SYSTEM,
      prompt: `Question (in ${LANG_NAMES[lang]}):\n${query}`,
      temperature: 0,
      maxOutputTokens: 300,
    });
    return { text: text.trim().replace(/^["'\s]+|["'\s]+$/g, ''), translated: true };
  } catch (err) {
    // A translation failure must not take the request down: fall back to the
    // original text. The embedding model is multilingual, so a native-language
    // query still retrieves reasonably.
    console.warn(`[translator] falling back to raw query: ${err.message}`);
    return { text: query, translated: false, error: err.message };
  }
}
