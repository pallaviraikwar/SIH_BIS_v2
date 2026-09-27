import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The chat route is the only place a real client's `lang` is read.
 *
 * A Hindi question came back as the single word "नहीं।" with `meta.lang: "en"`
 * while retrieval was perfect (band=answer, topSimilarity 0.7694, five real
 * clauses). The cause was one line here:
 *
 *     const lang = SUPPORTED_LANGS.includes(rawLang) ? rawLang : 'en';
 *
 * 'auto' is deliberately not in SUPPORTED_LANGS, so every 'auto' the frontend
 * sends was rewritten to 'en' before rag.js could act on it. Translation still
 * ran, because translation is driven by the script rather than by this flag,
 * which is exactly what made the failure so quiet: the system looked healthy in
 * every field except the one the user reads.
 *
 * These tests mock the model so the wiring is verifiable in milliseconds, with
 * no Ollama and no network. The point is to pin the contract between the route
 * and rag.js, which nothing covered before.
 */
const answered = [];
const closed = [];

const fakeResult = (lang, translationUsed) => ({
  answer: '<p>ok</p>',
  sources: [],
  answerText: 'ok',
  notFound: false,
  meta: { lang, translationUsed, band: 'answer' },
});

mock.module('../src/rag.js', {
  namedExports: {
    answerQuestion: async ({ query, lang }) => {
      answered.push({ query, lang });
      // Mirror the real contract: the reply language is whatever the translator
      // resolved, which is driven by the script of the query.
      const detected = /[\u0900-\u097F]/.test(query)
        ? 'hi'
        : /[\u0C00-\u0C7F]/.test(query)
          ? 'te'
          : 'en';
      return fakeResult(detected, detected !== 'en');
    },
  },
});

const { chatRouter } = await import('../src/routes/chat.js');
const { resolveLang } = await import('../src/routes/chat.js');
const { SUPPORTED_LANGS } = await import('../src/config.js');

/** Drive the router without a server or a real socket. */
function post(body) {
  return new Promise((resolvePromise) => {
    const req = { body, method: 'POST', url: '/chat' };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolvePromise({ status: this.statusCode, payload });
        return this;
      },
    };
    chatRouter.handle(req, res, () => {
      resolvePromise({ status: 500, payload: { error: 'unhandled' } });
    });
  });
}

test("'auto' survives the route instead of being rewritten to 'en'", () => {
  // The single line that caused the bug. Asserted on its own so a regression
  // points at the coercion rather than at whatever it eventually broke.
  assert.equal(resolveLang('auto', 'packaged drinking water limit').request, 'auto');
});

test('an absent or unrecognised lang is treated as auto, not as English', () => {
  for (const raw of [undefined, null, '', 'klingon', 42, {}]) {
    assert.equal(
      resolveLang(raw, 'packaged drinking water limit').request,
      'auto',
      `lang=${JSON.stringify(raw)} should be auto`
    );
  }
});

test('an explicit supported lang is passed through untouched', () => {
  for (const lang of SUPPORTED_LANGS) {
    assert.equal(resolveLang(lang, 'packaged drinking water limit').request, lang);
  }
});

test("'auto' is never added to SUPPORTED_LANGS to make the above pass", () => {
  // It is tempting to fix this by adding 'auto' to the list. That would break
  // normaliseLang() (translator.js) and the i18n table checks, both of which
  // require SUPPORTED_LANGS to contain only real languages. Pin the constraint
  // so the shortcut does not get taken later.
  assert.ok(!SUPPORTED_LANGS.includes('auto'), 'auto must not be a supported lang');
});

test('the canned error copy is keyed by a real language, never by auto', () => {
  // NO_QUESTION and ERROR_REPLY are indexed by real language and have no 'auto'
  // entry, so the route needs a separate concrete language for them. Detection
  // from the query text is what makes a Hindi user get a Hindi error message.
  assert.equal(resolveLang('auto', 'सीमेंट की मज़बूती कितनी?').ui, 'hi');
  assert.equal(resolveLang('auto', 'ప్యాకేజ్డ్ వాటర్ లిమిట్?').ui, 'te');
  assert.equal(resolveLang('auto', 'packaged drinking water limit').ui, 'en');
  // No text to inspect, so detection is meaningless and English is the fallback.
  assert.equal(resolveLang('auto', '').ui, 'en');
  assert.equal(resolveLang('auto', '   ').ui, 'en');
});

test('a Hindi question sent as auto is answered as Hindi', async () => {
  answered.length = 0;
  const { status, payload } = await post({
    query: 'सीमेंट की 28 दिन की compressive strength कितनी होनी चाहिए?',
    lang: 'auto',
  });

  assert.equal(status, 200);
  assert.equal(answered[0].lang, 'auto', "the route must forward 'auto', not 'en'");
  assert.equal(payload.meta.lang, 'hi', 'the reply language must be the one that was typed');
  assert.equal(payload.meta.translationUsed, true);
});

test('a Telugu question sent as auto is answered as Telugu', async () => {
  answered.length = 0;
  const { payload } = await post({ query: 'ప్యాకేజ్డ్ డ్రింకింగ్ వాటర్ లిమిట్ ఎంత?', lang: 'auto' });
  assert.equal(answered[0].lang, 'auto');
  assert.equal(payload.meta.lang, 'te');
});

test('an English question sent as auto is answered as English', async () => {
  answered.length = 0;
  const { payload } = await post({ query: 'What is the total dissolved solids limit?', lang: 'auto' });
  assert.equal(answered[0].lang, 'auto');
  assert.equal(payload.meta.lang, 'en');
  assert.equal(payload.meta.translationUsed, false);
});

test('the default request body, with no lang at all, is auto', async () => {
  // A client that omits the field entirely must not be read as asking for
  // English. This is the shape of the bug report, minus the explicit 'auto'.
  answered.length = 0;
  const { payload } = await post({ query: 'सीमेंट की मज़बूती कितनी?' });
  assert.equal(answered[0].lang, 'auto');
  assert.equal(payload.meta.lang, 'hi');
});

test('an empty question is rejected without a broken i18n lookup', async () => {
  // There is no text to detect a language from, so English is the honest
  // fallback rather than a guess. What must never happen is the missing-key
  // failure: a lookup that returns undefined used to render as the literal
  // string "undefined" in the chat bubble.
  const { status, payload } = await post({ query: '   ', lang: 'auto' });
  assert.equal(status, 400);
  assert.equal(payload.answer, 'Please type a question about a BIS standard.');
  assert.ok(!payload.answer.includes('undefined'), 'a missing i18n key must never render');
});

test('an empty question still honours an explicit lang for the error copy', async () => {
  // Detection is impossible here, so the explicit choice is all there is to go
  // on. This is the case the separate `ui` language exists for.
  const { status, payload } = await post({ query: '', lang: 'hi' });
  assert.equal(status, 400);
  assert.match(payload.answer, /कृपया/);
});
