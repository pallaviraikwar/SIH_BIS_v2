/**
 * Translation tests.
 *
 * These exist because of a specific, measured failure, and the shape of the suite
 * follows that failure rather than a general "translation is nice" theme.
 *
 * The bug: `toEnglishQuery` returned `translated: true` on output that was 86%
 * Devanagari, and the caller trusted it and embedded the result. A Hindi question
 * about food-grade plastics then scored 0.5919 against a clause about scratch
 * depth on a table top, and the user was shown it as their closest match. Nothing
 * anywhere reported a problem, because every layer believed the translation had
 * worked.
 *
 * So the central assertion is not that translation happens — it is that
 * `translated: true` is unreachable from a failed translation. The other tests pin
 * the specific input and output shapes that produced the original failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectScript,
  looksNonLatin,
  normaliseLang,
  langName,
  buildTranslationPrompt,
  cleanTranslation,
  validateEnglish,
  extractLatinFallback,
  toEnglishQuery,
} from '../src/translator.js';
import { isTranslatable, TRANSLATABLE_LANGS, SUPPORTED_LANGS } from '../src/config.js';

// ---------------------------------------------------------------------------
// detectScript
// ---------------------------------------------------------------------------

test('detectScript identifies each script from its Unicode block', () => {
  assert.equal(detectScript('What is the TDS limit?'), 'latin');
  assert.equal(detectScript('पैकेजबंद पेयजल में TDS की सीमा क्या है?'), 'hi');
  assert.equal(detectScript('ప్యాకేజ్డ్ డ్రింకింగ్ వాటర్ లిమిట్ ఎంత?'), 'te');
  assert.equal(detectScript('ਪੈਕ ਕੀਤਾ ਪਾਣੀ ਦੀ ਸੀਮਾ'), 'pa');
});

test('detectScript returns latin for a single stray non-Latin character', () => {
  // "café" contains one character above U+00FF. Requiring two stops an accent or a
  // stray currency sign from being answered as French.
  assert.equal(detectScript('café'), 'latin');
  assert.equal(detectScript('₹500'), 'latin');
});

test('detectScript takes the majority script for mixed input', () => {
  // The realistic mixed case: an English technical term carried inside a native
  // sentence. The terms must not drag the answer out of the native language, or the
  // reply language flips away from the language the user wrote in.
  assert.equal(detectScript('TDS की सीमा क्या है?'), 'hi');
  assert.equal(detectScript('IS 456 में cement की strength कितनी है?'), 'hi');
  // Live smoke-test query: "బ్రిక్‌ల compressive strength ఎంత?"
  assert.equal(detectScript('బ్రిక్‌ల compressive strength ఎంత?'), 'te');
});

test('detectScript needs a real share of native script, not one word', () => {
  // A single foreign word inside an English sentence is not a language change, and
  // treating it as one would send an English question to the translator on the
  // strength of two characters. At 9% non-Latin this stays Latin.
  assert.equal(detectScript('what is compressive strength ఎంత'), 'latin');
});

test('detectScript reads a mostly-native sentence as native even with a Latin prefix', () => {
  // The converse of the above, and the case that would be wrong in the other
  // direction: an English lead-in must not stop a Hindi question being Hindi.
  assert.equal(detectScript('fly ash के बारे में बताएं'), 'hi');
});

test('detectScript handles empty and non-string input without throwing', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(detectScript(bad), 'latin', `expected latin for ${JSON.stringify(bad)}`);
  }
});

test('looksNonLatin is unchanged and still the gate for translation', () => {
  // Pinned because chunker.test.js asserts the same three cases; if this changes
  // the two suites would disagree about when a translation is even attempted.
  assert.equal(looksNonLatin('What is the TDS limit?'), false);
  assert.equal(looksNonLatin('पैकेजबंद पेयजल में TDS की सीमा क्या है?'), true);
  assert.equal(looksNonLatin('ప్యాకేజ్డ్ డ్రింకింగ్ వాటర్ లిమిట్'), true);
  assert.equal(looksNonLatin('ਪੈਕ ਕੀਤਾ ਪਾਣੀ ਦੀ ਸੀਮਾ'), true);
});

// ---------------------------------------------------------------------------
// buildTranslationPrompt
// ---------------------------------------------------------------------------

test('buildTranslationPrompt matches the HY-MT card template exactly', () => {
  // Asserted byte-for-byte on purpose. This is a base model, not an instruct model:
  // it responds to the shape of its prompt, and the model card is the only authority
  // on the shape it was trained with. An "improvement" here that adds a system turn
  // or an extra rule degrades translation quality invisibly, so it has to fail here.
  assert.equal(
    buildTranslationPrompt('मुझे बताएं'),
    'Translate the following segment into English, without additional explanation.\n\nमुझे बताएं'
  );
});

test('buildTranslationPrompt puts the source after a blank line and adds nothing', () => {
  const prompt = buildTranslationPrompt('బ్రిక్ compressive strength');
  const [instruction, source] = prompt.split('\n\n');
  assert.equal(source, 'బ్రిక్ compressive strength');
  // No trailing instruction, no role markers, no chat scaffolding. The old
  // TRANSLATE_SYSTEM prompt carried five bullet rules; a base model reads those as
  // text to translate rather than as instructions, which is why they are gone.
  assert.ok(!instruction.includes('IS numbers'));
  assert.ok(!instruction.toLowerCase().includes('you are'));
  assert.ok(!prompt.includes('system'));
});

// ---------------------------------------------------------------------------
// cleanTranslation
// ---------------------------------------------------------------------------

test('cleanTranslation strips quotes and a translation label', () => {
  assert.equal(cleanTranslation('"Please tell me about fly ash."'), 'Please tell me about fly ash.');
  assert.equal(cleanTranslation("'fly ash'"), 'fly ash');
  assert.equal(cleanTranslation('Translation: fly ash'), 'fly ash');
  assert.equal(cleanTranslation('English: fly ash'), 'fly ash');
  assert.equal(cleanTranslation('Output — fly ash'), 'fly ash');
});

test('cleanTranslation cuts the instruction when the model echoes it', () => {
  // The failure mode where a model restates the prompt and then answers it. The
  // embedded instruction is the only line that has to go, or the search query
  // becomes a paragraph about translation.
  const echoed = [
    'Translate the following segment into English, without additional explanation.',
    'मुझे बताएं',
    'Please tell me about fly ash.',
  ].join('\n');
  assert.equal(cleanTranslation(echoed, 'मुझे बताएं'), 'Please tell me about fly ash.');
});

test('cleanTranslation keeps the first non-empty line and collapses whitespace', () => {
  assert.equal(cleanTranslation('\n\n  fly ash  \n  extra prose'), 'fly ash');
  assert.equal(cleanTranslation('  what   is   fly   ash '), 'what is fly ash');
});

test('cleanTranslation survives empty input', () => {
  assert.equal(cleanTranslation(''), '');
  assert.equal(cleanTranslation(null), '');
  assert.equal(cleanTranslation(undefined), '');
});

test('cleanTranslation leaves a clean model response untouched', () => {
  // Measured against the live model: all six real BIS questions came back as bare
  // English with no wrapper. The cleaner is defensive, so the common path must be a
  // no-op or it will be quietly mangling good output.
  const raw = 'What is the compressive strength of cement in IS 456?';
  assert.equal(cleanTranslation(raw), raw);
});

// ---------------------------------------------------------------------------
// validateEnglish — the three verdicts
// ---------------------------------------------------------------------------

test('validateEnglish accepts a good translation', () => {
  const v = validateEnglish('Please tell me about food-grade plastic.', 'मुझे फ़ूड-ग्रेड प्लास्टिक के बारे में बताएं।');
  assert.equal(v.status, 'ok');
  assert.equal(v.reason, null);
});

test('validateEnglish FAILS on output that is still native script', () => {
  // The exact failure from the old implementation, at the measured rates. 78% was
  // the real observed ratio for the current prompt and 86% for a two-shot English
  // variant; both were reported as `translated: true`.
  for (const bad of [
    'फूड-ग्रेड प्लास्टिक के बारे में जानकारी दीजिए यह क्या है और इसका उपयोग क्या',
    'खाद्य-श्रेणी प्लास्टिक के बारे में जानकारी',
    'ప్యాకేజ్డ్ డ్రింకింగ్ వాటర్ లిమిట్ ఎంత అని అడుగుతున్నారు',
  ]) {
    const v = validateEnglish(bad, 'मुझे बताएं');
    assert.equal(v.status, 'fail', `should fail: ${bad}`);
    assert.match(v.reason, /native_script/);
  }
});

test('validateEnglish FAILS on empty output', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.equal(validateEnglish(bad, 'मुझे बताएं').status, 'fail');
  }
});

test('validateEnglish FAILS on output with no Latin letters at all', () => {
  const v = validateEnglish('??? 12345 ???', 'मुझे बताएं');
  assert.equal(v.status, 'fail');
  assert.equal(v.reason, 'no_ascii_letters');
});

test('validateEnglish FAILS when the text came back unchanged', () => {
  // An echo is not a translation, and reporting it as one is the original bug in a
  // different costume: the retrieval query is still in the wrong script.
  const same = 'मुझे बताएं';
  const v = validateEnglish(same, same);
  assert.equal(v.status, 'fail');
  assert.equal(v.reason, 'unchanged');
});

test('validateEnglish marks romanised Hindi as suspect, not fail', () => {
  // Real observed behaviour: given "नमस्ते, आप कैसे है", HY-MT1.5 returned
  // "Hai, how are you?" — नमस्ते romanised rather than translated. The output is
  // entirely Latin, so every script check passes it. This is the case script
  // validation alone cannot catch, and it must not hard-fail: rejecting a correct
  // translation over a short word list is a worse failure than the one being caught.
  const v = validateEnglish('Hai, how are you?', 'नमस्ते, आप कैसे है');
  assert.equal(v.status, 'suspect');
  assert.ok(v.romanised.includes('hai'));
  assert.match(v.reason, /romanised_hindi/);
});

test('validateEnglish does not treat common English words as romanised Hindi', () => {
  // Regression guard. An earlier word list included `is`, `ka`, `ki`, `ke` and `ko`,
  // which flagged all six real smoke-test translations on the word "is". A check
  // that fires on correct output gets ignored, which is worse than not having it.
  for (const good of [
    'What is the limit for packaged drinking water?',
    'What is the compressive strength of cement in IS 456?',
    'Is it permissible to add kaolin to the mix?',
    'Keep the keystone arch in place during casting.',
  ]) {
    const v = validateEnglish(good, 'मुझे बताएं');
    assert.ok(
      v.status === 'ok' || v.lostAnchors.length,
      `"${good}" flagged as romanised: ${v.reason}`
    );
    if (v.romanised.length) {
      assert.fail(`"${good}" matched romanised tokens: ${v.romanised.join(',')}`);
    }
  }
});

test('validateEnglish flags a standard code dropped in translation', () => {
  // Suspicious, not fatal. The translation is usable, but losing "IS 456" means
  // `parseIsIdentifier` cannot promote the entry, so the query retrieves the wrong
  // thing. Surfaced as a warning on every return path rather than tolerated.
  const v = validateEnglish('What is the compressive strength of cement?', 'IS 456 compressive strength कितनी है?');
  assert.equal(v.status, 'suspect');
  assert.ok(v.lostAnchors.includes('is 456'));
  assert.match(v.reason, /lost:/);
});

test('validateEnglish accepts a translation that preserves codes and numbers', () => {
  // Live output from the real model, unchanged.
  const v = validateEnglish(
    'What is the TDS limit for packaged drinking water? What does 500 mg/l represent?',
    'पैकेजबंद पेयजल में TDS की सीमा क्या है? 500 mg/l कितना होता है?'
  );
  assert.equal(v.status, 'ok');
  assert.deepEqual(v.lostAnchors, []);
});

// ---------------------------------------------------------------------------
// extractLatinFallback
// ---------------------------------------------------------------------------

test('extractLatinFallback keeps designations and Latin technical terms', () => {
  const out = extractLatinFallback('IS 456 में cement की compressive strength कितनी है?');
  assert.match(out, /IS 456/i);
  assert.match(out, /cement/i);
  assert.match(out, /compressive strength/i);
});

test('extractLatinFallback keeps unit-bearing quantities', () => {
  const out = extractLatinFallback('500 mg/l की सीमा क्या है?');
  assert.match(out, /500 mg\/l/i);
});

test('extractLatinFallback drops the native text entirely', () => {
  // nomic-embed-text is English-only. The old code's fallback comment claimed
  // "the embedding model is multilingual, so a native-language query still
  // retrieves reasonably" — that is what produced the 0.5919 scratch-depth result.
  const out = extractLatinFallback('मुझे फ़ूड-ग्रेड प्लास्टिक के बारे में बताएं।');
  for (const ch of out) assert.ok(ch.codePointAt(0) <= 0x00ff, `leaked native char: ${ch}`);
});

test('extractLatinFallback returns empty string for pure native text', () => {
  // Not a crash — an empty query, which the caller treats as a hard translation
  // failure and answers with the degraded reply. Better than searching on noise.
  assert.equal(extractLatinFallback('मुझे बताएं').trim(), '');
});

// ---------------------------------------------------------------------------
// Language support
// ---------------------------------------------------------------------------

test('Punjabi is a supported interface language but is not translatable', () => {
  // The distinction is the whole point. Punjabi gets a Punjabi reply and has
  // always retrieved badly; HY-MT1.5's language list does not include Gurmukhi, and
  // asking it anyway does not fail loudly — measured, it returned the fluent and
  // entirely unrelated "Is it really necessary to have such a complicated system?"
  // for "ਈੱਟ ਬਲਾਕ ਕੀ ਘਣੀ ਹੈ?". Passing through beats inventing.
  assert.ok(SUPPORTED_LANGS.includes('pa'));
  assert.ok(!isTranslatable('pa'));
  assert.ok(isTranslatable('hi'));
  assert.ok(isTranslatable('te'));
  assert.deepEqual(TRANSLATABLE_LANGS, ['en', 'hi', 'te']);
});

test('normaliseLang and langName are unchanged', () => {
  assert.equal(normaliseLang('hi'), 'hi');
  assert.equal(normaliseLang('xx'), 'en');
  assert.equal(normaliseLang(undefined), 'en');
  assert.match(langName('te'), /Telugu/);
  assert.match(langName('pa'), /Punjabi/);
});

// ---------------------------------------------------------------------------
// toEnglishQuery — routing
//
// The provider is injected rather than stubbed at module scope, because an ES
// module namespace is immutable and `Object.defineProperty` on one throws. The
// seam also makes the assertion that matters expressible: the English and Punjabi
// paths pass `mustNotTranslate`, which throws if the model is reached at all.
// ---------------------------------------------------------------------------

/** Fails the test if invoked. Proves a path made no model call. */
const mustNotTranslate = () => {
  throw new Error('the translation model must not be called on this path');
};

/** Stands in for the model, returning fixed text. */
const returning = (text) => async () => ({ text, provider: 'stub' });

const HINDI_FOOD = 'मुझे फ़ूड-ग्रेड प्लास्टिक के बारे में बताएं।';

test('an English query never calls the translation model', async () => {
  const r = await toEnglishQuery('What is the TDS limit?', 'auto', { translate: mustNotTranslate });
  assert.equal(r.translated, false);
  assert.equal(r.text, 'What is the TDS limit?');
  assert.equal(r.lang, 'en');
  assert.equal(r.error, undefined);
});

test('a Punjabi query is passed through without calling the model', async () => {
  const r = await toEnglishQuery('ਪੈਕ ਕੀਤਾ ਪਾਣੀ ਦੀ ਸੀਮਾ', 'auto', { translate: mustNotTranslate });
  assert.equal(r.translated, false);
  assert.equal(r.unsupported, true);
  assert.equal(r.lang, 'pa');
});

test('a Devanagari query is translated and reports the Hindi it detected', async () => {
  const r = await toEnglishQuery(HINDI_FOOD, 'auto', {
    translate: returning('Please tell me about food-grade plastic.'),
  });
  assert.equal(r.translated, true);
  assert.equal(r.lang, 'hi');
  assert.equal(r.text, 'Please tell me about food-grade plastic.');
  // Always a boolean, never absent, so a consumer does not have to distinguish
  // "false" from "not reported".
  assert.equal(r.suspect, false);
  assert.deepEqual(r.translationWarnings, []);
});

test('a Telugu query is translated', async () => {
  const r = await toEnglishQuery('బ్రిక్ compressive strength ఎంత?', 'auto', {
    translate: returning('What is the compressive strength of brick?'),
  });
  assert.equal(r.translated, true);
  assert.equal(r.lang, 'te');
});

test('THE INVARIANT: a failed translation never reports translated:true', async () => {
  // The test the original bug should have failed. Every unusable shape the real
  // model actually produced, fed through the real caller, must come back with an
  // error so the request takes the degraded path instead of searching on garbage.
  const unusable = [
    'फूड-ग्रेड प्लास्टिक के बारे में जानकारी दीजिए यह क्या है',   // 100% native
    'Translate the following segment into English, without additional explanation.', // echo
    '',                                                                        // empty
    '???',                                                                     // no letters
    'मुझे फ़ूड-ग्रेड प्लास्टिक के बारे में बताएं।',                 // unchanged
  ];

  for (const raw of unusable) {
    const r = await toEnglishQuery(HINDI_FOOD, 'auto', { translate: returning(raw) });
    assert.equal(
      r.translated,
      false,
      `reported success for unusable output: ${JSON.stringify(raw)}`
    );
    assert.ok(r.error, `a failed translation must carry an error: ${JSON.stringify(raw)}`);
  }
});

test('a thrown translation becomes a returned error, not a rejected promise', async () => {
  // The caller already has a degraded path for `error`; an exception would take the
  // request down instead, and "model not pulled" is the most likely real cause.
  const r = await toEnglishQuery('मुझे बताएं कि सीमेंट कितना मजबूत है', 'auto', {
    translate: async () => {
      throw new Error('Ollama does not have "x". Run: ollama pull x');
    },
  });
  assert.equal(r.translated, false);
  assert.match(r.error, /not have/);
  // Whatever it fell back to must be searchable, not native script.
  for (const ch of r.text) {
    assert.ok(ch.codePointAt(0) <= 0x00ff, `fallback leaked native char: ${ch}`);
  }
});

test('a suspect translation is served but carries the warning', async () => {
  // Suspect must not fail the request: the answer is usable. The warning exists so
  // the condition is visible in `meta` and the logs rather than tolerated silently.
  const r = await toEnglishQuery('नमस्ते, सीमेंट कितनी मजबूत है बताइए', 'auto', {
    translate: returning('Hai, bataiye cement kitni hai?'),
  });
  assert.equal(r.translated, true);
  assert.equal(r.suspect, true);
  assert.ok(r.translationWarnings.length);
  assert.match(r.translationWarnings.join(' '), /romanised_hindi/);
});

test('an explicit lang overrides the detected one, and auto defers to detection', async () => {
  const t = returning('Tell me about fly ash.');
  // 'auto' is what the frontend sends now, and it must not pin the language.
  assert.equal((await toEnglishQuery('मुझे बताएं', 'auto', { translate: t })).lang, 'hi');
  // An explicit choice still wins, so the override path is not dead code.
  assert.equal((await toEnglishQuery('मुझे बताएं', 'te', { translate: t })).lang, 'te');
});

test("an explicit 'en' does not override a clear non-Latin script", async () => {
  // The bug this hardening exists for. A caller sending `lang: 'en'` with a Hindi
  // question produced a prompt holding a Hindi question and the instruction to
  // answer in English; sarvam-1 resolved that by replying in Hindi anyway
  // ("नहीं।") while `meta.lang` reported 'en' and the UI switched to English to
  // show it. 'en' plus Devanagari is a stale client, never a considered choice.
  const t = returning('What is the compressive strength of cement?');
  assert.equal((await toEnglishQuery('सीमेंट की मज़बूती कितनी?', 'en', { translate: t })).lang, 'hi');
  assert.equal(
    (await toEnglishQuery('ప్యాకేజ్డ్ వాటర్ లిమిట్ ఎంత?', 'en', { translate: t })).lang,
    'te'
  );
});

test('the stale-en hardening does not override a real explicit choice', async () => {
  // Only 'en' is treated as a client bug. A caller that deliberately asks for a
  // particular non-English language still gets it, even against a mismatch.
  const t = returning('Tell me about fly ash.');
  assert.equal((await toEnglishQuery('ముర్కి మరియు మసాలా', 'hi', { translate: t })).lang, 'hi');
});

test('a script we cannot translate always answers in its own language', async () => {
  // Punjabi has no HY-MT1.5 support, so the text goes through untranslated. In
  // that case the detected script has to win even over an explicit choice:
  // replying to Gurmukhi text in Hindi is the same language mismatch the
  // stale-'en' hardening exists to prevent, just arrived at from the other side.
  const t = returning('unused');
  const r = await toEnglishQuery('ਕੀਤਾ ਪਾਣੀ ਦੀ ਸੀਮਾ', 'hi', { translate: t });
  assert.equal(r.lang, 'pa');
  assert.equal(r.translated, false);
  assert.equal(r.unsupported, true);
});

test("an explicit 'en' with Latin text is still English", async () => {
  // The hardening must not fire on ordinary English, which is the common case
  // for every request the frontend makes.
  const t = returning('unused');
  const r = await toEnglishQuery('What is the total dissolved solids limit?', 'en', { translate: t });
  assert.equal(r.lang, 'en');
  assert.equal(r.translated, false);
});

test('a clean model response is passed through byte-for-byte', async () => {
  // Live output from the real model. If the cleaner alters it, it is mangling good
  // translations — the cleaner is defensive and must be a no-op on the happy path.
  const good = 'What is the limit for packaged drinking water?';
  const r = await toEnglishQuery('ప్యాకేజ్డ్ డ్రింకింగ్ వాటర్ లిమిట్ ఎంత?', 'auto', {
    translate: returning(good),
  });
  assert.equal(r.text, good);
});
