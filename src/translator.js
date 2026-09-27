import { translateText } from './providers/index.js';
import { SUPPORTED_LANGS, isTranslatable } from './config.js';

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
  const sample = String(text ?? '').slice(0, 400);
  if (!sample) return false;
  let nonAscii = 0;
  for (const ch of sample) {
    if (ch.codePointAt(0) > 0x00ff) nonAscii++;
  }
  return nonAscii / sample.length > 0.15;
}

/**
 * Which language the user actually wrote in, by Unicode block.
 *
 * Needed because the reply language and the translation decision were both being
 * driven by a single `lang` field from the UI, and that coupled two unrelated
 * things. The reported bug was the coupling's fault: a Hindi question sent with
 * `lang: 'en'` skipped translation entirely (`lang === 'en'` short-circuited
 * `toEnglishQuery`), so raw Devanagari went into an English-only embedding model
 * and the top result was a clause about scratch depth on a table top, 0.5919.
 *
 * Reading the text instead of trusting a flag means the query decides both what it
 * gets searched as and what it gets answered in, and neither can be desynchronised
 * from what was actually typed.
 *
 * Ranges are the Unicode blocks themselves, not heuristics: Devanagari U+0900-097F,
 * Gurmukhi U+0A00-0A7F, Telugu U+0C00-0C7F. They do not overlap, so a character
 * identifies its script outright. The counts are only needed to pick a *majority*
 * for mixed input — a Hindi question with a Latin technical term in it ("TDS की
 * सीमा") still has to come back `hi`.
 *
 * Below the `looksNonLatin` threshold there is no script to speak of, and that is
 * the signal to return 'latin' without counting anything: transliterated or
 * romanised input has no reliable block and is better treated as English than
 * guessed at.
 */
const SCRIPT_BLOCKS = [
  { lang: 'hi', from: 0x0900, to: 0x097f },
  { lang: 'pa', from: 0x0a00, to: 0x0a7f },
  { lang: 'te', from: 0x0c00, to: 0x0c7f },
];

export function detectScript(text) {
  const sample = String(text ?? '').slice(0, 400);
  if (!sample || !looksNonLatin(sample)) return 'latin';

  const counts = Object.create(null);
  for (const ch of sample) {
    const cp = ch.codePointAt(0);
    for (const block of SCRIPT_BLOCKS) {
      if (cp >= block.from && cp <= block.to) {
        counts[block.lang] = (counts[block.lang] ?? 0) + 1;
        break;
      }
    }
  }

  let best = null;
  let bestCount = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  // A stray accent or a lone currency sign is not a language. Requiring two
  // characters keeps "café ₹500" from being answered in French.
  return bestCount >= 2 ? best : 'latin';
}

/**
 * The prompt HY-MT1.5 is documented to take.
 *
 * Exact template, no additions. A base model is sensitive to the shape of its
 * prompt in a way an instruct model is not, and the model card is the only
 * authority on what it was trained with — so this is asserted byte-for-byte in
 * test/translator.test.js, and a change here fails the suite rather than silently
 * producing a slightly worse translation.
 *
 * Note what the template does *not* ask for, and why: the previous `TRANSLATE_SYSTEM`
 * prompt also demanded "keep every standard designation verbatim" and "keep numeric
 * limits and units exactly as written". Those rules were needed for sarvam-1, which
 * was answering instead of translating and so needed to be told what a translation
 * was. HY-MT1.5 does the task already, and extra instructions on a base model tend
 * to read as text to translate. Preservation is instead *checked* in
 * `validateEnglish` rather than requested in the prompt, so a dropped IS code
 * becomes a visible warning instead of a silent retrieval failure.
 */
export function buildTranslationPrompt(query) {
  return `Translate the following segment into English, without additional explanation.\n\n${query}`;
}

/**
 * Strip whatever wrapper the model put around the translation.
 *
 * Measured against the live model, HY-MT1.5 is well behaved here: six real BIS
 * questions in Hindi and Telugu came back as bare English sentences, with no
 * preamble, no surrounding quotes and no echo of the prompt. This is defensive
 * rather than corrective, which is the right way round — a cleaner that only ever
 * runs when the model misbehaves costs nothing when it does not, and saves the
 * output when it does.
 *
 * The order matters. A quoted wrapper is stripped first so that a label sitting
 * inside the quotes is visible to the next step, and the prompt echo is cut before
 * the single-line filter, since an echoed prompt is always a line of its own.
 */
export function cleanTranslation(raw, original = '') {
  let text = String(raw ?? '').trim();

  // The model echoing the instruction. Everything up to and including the template
  // is dropped, and so is the source that follows it. A base model that restates its
  // prompt restates the *source text* immediately afterwards, so cutting only the
  // instruction leaves the question the user already typed as the first surviving
  // line — and that line then becomes the search query.
  if (text.includes('without additional explanation')) {
    const tail = text.split(/without additional explanation/i).pop();
    if (tail && tail.trim()) text = tail.trim();
  }

  // Surrounding quotes, then any "Translation:"-style label they were hiding. Both
  // dash characters are in the class: an en dash from a keyboard layout and an em
  // dash from a model that picks its own punctuation. The em dash was a real miss —
  // "Output \u2014 fly ash" survived unstripped, and a search query beginning with
  // "Output" is worse than no translation at all.
  text = text.replace(/^[\"'\u201c\u2018]+/g, '').replace(/[\"'\u201d\u2019]+$/g, '').trim();
  text = text.replace(
    /^(?:english\s+)?(?:translat(?:ion|ed|e)|output|answer|result|english)\s*[:\-\u2013\u2014]\s*/i,
    ''
  );

  // A translation is one line. Lines are filtered *before* one is chosen, because
  // after an echo the leading lines are debris: the tail of the instruction, the
  // source text, or a bare period left where the cut landed. Taking the first
  // non-empty line instead returns "." and sends that to the embedding model.
  const source = String(original ?? '').trim();
  const norm = (v) => v.replace(/\s+/g, ' ').trim().toLowerCase();
  const lines = text.split('\n').map((line) => line.trim());
  const useful = lines.filter((line) => {
    if (line.length < 2) return false; // empty, or a single character of debris
    if (/^[^\p{L}\p{N}]+$/u.test(line)) return false; // punctuation only
    if (source && norm(line) === norm(source)) return false; // the source, echoed
    return true;
  });

  text = (useful[0] ?? lines.find((l) => l.length > 0) ?? '').trim();

  return text.replace(/\s+/g, ' ').trim();
}

/** The Latin technical anchors that must survive a translation of a BIS question. */
const ANCHOR_PATTERNS = [
  /\bIS\s*:?\s*\d{1,6}/gi, // standard designations, with or without the colon
  /\bSP\s*:?\s*\d{1,6}/gi,
  // Every slash is escaped. An unescaped one inside a regex literal — "N/mm2" —
  // silently terminates the literal early and the remainder is parsed as division,
  // which fails as "Invalid regular expression flags" rather than as a bad pattern.
  /\b\d+(?:\.\d+)?\s*(?:MPa|N\/mm2|mg\/l|mg\/kg|%|g\/l|µm|mm|cm|kg)\b/gi,
];

/**
 * The technical anchors present in a source query, normalised for comparison.
 *
 * The unit-bearing numbers matter more than they look. A translation that keeps
 * "IS 456" but loses "28" is worse than useless here: SP 21 is a summary catalogue
 * whose value is in the designations and the limits, and `parseIsIdentifier` gates
 * the promotion that lets a bare "IS 456" find the entry that prints it.
 */
function extractAnchors(text) {
  const found = new Set();
  for (const re of ANCHOR_PATTERNS) {
    for (const match of String(text ?? '').matchAll(re)) {
      // Collapse internal whitespace so "IS  456" and "IS 456" compare equal.
      found.add(match[0].replace(/\s+/g, ' ').toLowerCase());
    }
  }
  return found;
}

/**
 * Romanised Hindi function words, matched as whole lowercase tokens.
 *
 * Deliberately excludes anything that is also an English word. An earlier draft
 * included `is`, `ka`, `ki`, `ke` and `ko`, which flagged every one of the six
 * smoke-test translations on the word "is" — a check that cries wolf on correct
 * output gets ignored, which is worse than not having it. Every token below is
 * unambiguously Hindi and not English.
 *
 * The reason for the check at all: HY-MT1.5 can leave native words romanised
 * rather than translated. Given "नमस्ते, आप कैसे है" it returned "Hai, how are
 * you?" — the greeting romanised into Latin instead of becoming "Hello". That
 * output passes every script check, because the whole point is that it is Latin.
 * For a technical question the same behaviour can produce a search query that is
 * mostly transliterated Hindi, which retrieves nothing while looking translated.
 */
const ROMANISED_HINTS =
  /\b(?:hai|hain|hoon|kya|kyun|kaise|kaun|kitna|kitni|kitne|batao|bataiye|mujhe|humko|aapko|aap|mera|meri|apna|apni|mukhya|vaare|vah|yah|kahan|kithe|liye|waala|hota|hoti|karna|kare|dena|raha|rahi|rahe)\b/gi;

/** Case-insensitive whole-token membership, so `hai` in "Chennai" is not a hit. */
function romanisedHits(text) {
  const hits = new Set();
  for (const m of String(text ?? '').matchAll(ROMANISED_HINTS)) hits.add(m[0].toLowerCase());
  return [...hits];
}

/**
 * Did the translation actually come back in usable English?
 *
 * Three outcomes rather than a boolean, because the failure modes need different
 * responses and only one of them is fatal.
 *
 *   fail     Definitely unusable. Sent to the caller as a translation error, which
 *            routes the request to the degraded reply instead of searching on
 *            garbage. This is the original bug: the old code reported
 *            `translated: true` on 86%-Devanagari output and retrieval then ran
 *            on a question the model had never translated.
 *
 *   suspect  Passed the hard checks but shows a warning sign — romanised Hindi
 *            left in the text, or a standard code/number that did not survive.
 *            Deliberately NOT a hard failure. Both signals are heuristics, and
 *            rejecting a correct translation because it happened to contain a
 *            token from a short word list would be a worse failure than the one
 *            being caught. The answer is used, and the warning is surfaced in
 *            `meta` and logged, so a real pattern shows up in the logs instead of
 *            being silently tolerated.
 *
 *   ok       Clean English, nothing lost.
 *
 * The invariant this function exists to protect: **`translated: true` may only
 * ever follow `ok` or `suspect` after a real model call**, and never a `fail`. A
 * failed translation that reports success is strictly worse than no translation,
 * because it converts a visible error into an invisible wrong answer.
 */
export function validateEnglish(translated, original = '') {
  const text = String(translated ?? '').trim();
  if (!text) return { status: 'fail', reason: 'empty', romanised: [], lostAnchors: [] };

  // Order is diagnostic, not arbitrary. All three of these are `fail`, so the
  // verdict is the same whichever fires first — but the *reason* is what a person
  // reads in the logs, and the most specific one is the most useful.
  //
  // `unchanged` goes first because an echo satisfies both other checks as well
  // (a Devanagari source echoed verbatim is both "no ASCII letters" and "still
  // native script") and reporting either of those would send someone looking at
  // the wrong problem. The model restated the question; that is the finding.
  if (original && text === String(original).trim()) {
    return { status: 'fail', reason: 'unchanged', romanised: [], lostAnchors: [] };
  }

  // Still mostly native script. This is the check the old code omitted, and the one
  // that was actually load-bearing: 78% and 86% Devanagari both sailed through as
  // successful translations. Checked before the ASCII test below so that a response
  // which is *entirely* Devanagari is diagnosed as the script problem it is, rather
  // than as the absence of letters — which is a symptom of the same thing.
  const nonLatinRatio = looksNonLatin(text);
  if (nonLatinRatio) {
    return {
      status: 'fail',
      reason: `still_${Math.round(nonLatinRatio * 100)}pct_native_script`,
      romanised: [],
      lostAnchors: [],
    };
  }

  // No Latin letters, but also not enough native script to trip the test above:
  // punctuation and digits only, which is not a translation of anything.
  if (!/[A-Za-z]/.test(text)) {
    return { status: 'fail', reason: 'no_ascii_letters', romanised: [], lostAnchors: [] };
  }

  // Past this point it is English. What follows is about quality, not validity.
  const romanised = romanisedHits(text);
  const before = extractAnchors(original);
  const after = extractAnchors(text);
  const lostAnchors = [...before].filter((a) => !after.has(a));

  const warnings = [];
  if (romanised.length) warnings.push(`romanised_hindi:${romanised.join(',')}`);
  if (lostAnchors.length) warnings.push(`lost:${lostAnchors.join(',')}`);

  return {
    status: warnings.length ? 'suspect' : 'ok',
    reason: warnings.length ? warnings.join(' ') : null,
    romanised,
    lostAnchors,
  };
}

/**
 * What can still be searched when translation fails.
 *
 * Keeps the parts of a non-Latin query that are already in the right script for an
 * English-only embedding model: standard designations, bare numbers, and any
 * Latin technical terms the user typed alongside the Hindi. A query like
 * "IS 456 cement की strength" still contains enough to find the entry, where the
 * whole native string would find nothing.
 *
 * Deliberately does not return the original text. The old comment claimed "the
 * embedding model is multilingual, so a native-language query still retrieves
 * reasonably" — that is false for nomic-embed-text, which is English-only, and it
 * is precisely why the Devanagari query scored 0.5919 against an unrelated clause.
 */
export function extractLatinFallback(query) {
  const text = String(query ?? '');

  // Designations and unit-bearing quantities first, wherever they appear.
  const anchors = [...extractAnchors(text)];

  // Then any run of Latin words. This catches the technical term of art the user
  // typed in English inside an otherwise native sentence, and it is why the
  // fallback is a partial query rather than nothing.
  const latinWords = text.match(/[A-Za-z][A-Za-z0-9.\-]*(?:\s+[A-Za-z][A-Za-z0-9.\-]*)*/g) ?? [];

  const seen = new Set();
  const parts = [];
  for (const part of [...anchors, ...latinWords]) {
    const key = part.toLowerCase();
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    parts.push(part.trim());
  }
  return parts.join(' ').trim();
}

/**
 * Turn the user's question into an English query for retrieval.
 *
 * The corpus is English-only (BIS standards are published in English), so a Hindi
 * or Telugu question is translated before it is embedded. Measured on this corpus
 * that is decisively better than embedding the native question: "मुझे फ़ूड-ग्रेड
 * प्लास्टिक के बारे में बताएं" scores 0.5919 raw and 0.7118 translated, and the
 * translated form lands on cl. 2.1 p. 291, which is the only food-grade mention in
 * the index.
 *
 * Four paths, and the order is the point:
 *
 *   latin    Returned untouched, and no model is called. An English question must
 *            never depend on the translator being installed or healthy.
 *
 *   pa       Returned untouched, no model called. Punjabi is a supported interface
 *            language but not translatable — see TRANSLATABLE_LANGS. The question
 *            retrieves no better than it ever did, which is the honest state of
 *            it; routing it through a model that cannot read it produces confident
 *            nonsense instead (see the measured example there).
 *
 *   hi, te   Translated, cleaned, validated. `translated: true` only ever comes
 *            back from here, and only after a real model call returned something
 *            usable.
 *
 * A thrown translation is converted into a returned `error` rather than propagated,
 * because the caller already has a degraded path for it. The distinction that
 * matters: `error` means "this query was never really searchable" and the user is
 * told so, whereas the old fallback quietly passed the original text through and
 * let retrieval report a confident answer built on it.
 *
 * `translate` is injectable so the routing can be tested without a model present.
 * The English and Punjabi paths must be provable to make *no* call at all, and that
 * is only assertable by substituting something that throws if invoked — which an
 * ES module namespace will not allow, since its exports are immutable. Production
 * callers pass nothing and get the real provider.
 */
export async function toEnglishQuery(query, requestedLang, { translate = translateText } = {}) {
  const text = String(query ?? '');
  const detected = detectScript(text);

  // Which language the *answer* is written in.
  //
  // An explicit choice normally wins, so a caller that deliberately wants English
  // back gets English. There is one exception, and it exists because of a real
  // failure: a caller sending `lang: 'en'` with a Devanagari or Telugu question
  // gets a prompt containing a Hindi question and the instruction to answer in
  // English. sarvam-1 resolves that contradiction by replying in the language of
  // the question anyway — a Hindi "नहीं।" — while `meta.lang` reports 'en' and the
  // UI switches to English to display it.
  //
  // 'en' plus a clear non-Latin script is never a considered choice. It is a stale
  // client, a default that was never meant to be sent, or a caller that guessed
  // wrong. Treating it as a client bug and trusting the script costs nothing and
  // removes a whole class of "answer is in a language the UI isn't" reports. A
  // caller that genuinely wants English gets it by writing the question in English.
  const explicit = requestedLang && requestedLang !== 'auto' ? normaliseLang(requestedLang) : null;
  const lang = explicit === 'en' && detected !== 'latin' ? detected : explicit ?? detected;

  if (detected === 'latin') {
    return { text, translated: false, lang: 'en' };
  }

  if (!isTranslatable(detected)) {
    return {
      text,
      translated: false,
      lang: detected,
      unsupported: true,
    };
  }

  let raw;
  try {
    const res = await translate({ prompt: buildTranslationPrompt(text) });
    raw = res.text;
  } catch (err) {
    console.warn(`[translator] ${lang} translation failed: ${err.message}`);
    return {
      text: extractLatinFallback(text),
      translated: false,
      lang,
      error: err.message,
    };
  }

  const cleaned = cleanTranslation(raw, text);
  const verdict = validateEnglish(cleaned, text);

  if (verdict.status === 'fail') {
    console.warn(
      `[translator] ${lang} translation unusable (${verdict.reason}); ` +
        `model returned: ${JSON.stringify(cleaned.slice(0, 120))}`
    );
    return {
      text: extractLatinFallback(text),
      translated: false,
      lang,
      error: `translation unusable: ${verdict.reason}`,
    };
  }

  if (verdict.status === 'suspect') {
    // Not fatal, but never silent either. A translation that quietly lost "IS 456"
    // will retrieve the wrong clauses, and the only way to notice that from a
    // transcript is if it is recorded here.
    console.warn(`[translator] ${lang} translation suspicious (${verdict.reason}): ${cleaned}`);
  }

  return {
    text: cleaned,
    translated: true,
    lang,
    suspect: verdict.status === 'suspect',
    translationWarnings: verdict.reason ? [verdict.reason] : [],
    raw,
  };
}
