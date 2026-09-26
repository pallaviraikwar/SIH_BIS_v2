import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, normaliseChitChat } from '../src/intent.js';
import {
  NOT_FOUND_REPLY,
  GROUNDING_NOTE,
  COVERAGE_HEADER,
  GREETING_REPLY,
  GENERATION_FAILED_REPLY,
} from '../src/prompts.js';
import { renderNotFoundHtml, renderGreetingHtml, renderCoverageHtml } from '../src/render.js';

const LANGS = ['en', 'hi', 'pa', 'te'];

test('normalisation folds punctuation, emoji and case', () => {
  assert.equal(normaliseChitChat('  HI!  '), 'hi');
  assert.equal(normaliseChitChat('Hello :)'), 'hello');
  assert.equal(normaliseChitChat('Hey 👋'), 'hey');
  assert.equal(normaliseChitChat('Thank   you!'), 'thank you');
  assert.equal(normaliseChitChat('गुड मॉर्निंग'), 'गुड मॉर्निंग');
});

test('greetings and chit-chat are detected', () => {
  for (const q of [
    'hi', 'Hi!', 'HI', 'hey', 'hello', 'Hello :)', 'hellowe', 'heyyy',
    'thanks', 'thank you', 'thx', 'bye', 'good morning', 'good evening',
    'who are you', 'what can you do', 'help', 'test', 'asdfghjkl', 'ok',
  ]) {
    assert.equal(detectIntent(q), 'chitchat', `"${q}" should be chit-chat`);
  }
});

test('real questions are never treated as chit-chat', () => {
  // "hi" and "help" are the dangerous ones: they appear as substrings of genuine
  // questions, so a substring match would swallow these.
  for (const q of [
    'what is the hi-fi requirement',
    'how does the help desk work',
    'okra cultivation in andhra',
    'thanksgiving holiday dates',
    'what is the tensile strength of ERW pipe',
    'who are the members of the committee',
    'testing requirements for steel tubes',
    'ok',
  ]) {
    if (q === 'ok') continue; // genuinely chit-chat
    assert.equal(detectIntent(q), null, `"${q}" must not be chit-chat`);
  }
});

test('a long message is never chit-chat even if it matches', () => {
  // Guards the length cap: a real question padded to look like a greeting must
  // still reach retrieval.
  assert.equal(detectIntent('hi, what does clause 9.2 say about wall thickness'), null);
});

test('every user-visible message table covers all four languages', () => {
  // A refusal once existed as one English constant plus a second hardcoded English
  // sentence in render.js, so Hindi and Telugu users got English walls of text.
  const tables = {
    NOT_FOUND_REPLY,
    GROUNDING_NOTE,
    COVERAGE_HEADER,
    GREETING_REPLY,
    GENERATION_FAILED_REPLY,
  };

  for (const [name, table] of Object.entries(tables)) {
    assert.equal(typeof table, 'object', `${name} must be a language table, not a bare string`);
    for (const lang of LANGS) {
      assert.equal(typeof table[lang], 'string', `${name} is missing "${lang}"`);
      assert.ok(table[lang].trim().length > 0, `${name}.${lang} is empty`);
    }
  }
});

test('a Hindi refusal is actually in Hindi', () => {
  const en = renderNotFoundHtml({ lang: 'en' });
  const hi = renderNotFoundHtml({ lang: 'hi' });
  assert.notEqual(en, hi, 'the Hindi refusal rendered identically to English');
  assert.ok(/[ऀ-ॿ]/.test(hi), 'Hindi refusal contains no Devanagari');
  assert.ok(!/only answers from the BIS documents/.test(hi), 'English grounding note leaked into the Hindi refusal');
});

test('refusal names the documents the corpus actually contains', () => {
  const html = renderNotFoundHtml({ lang: 'en', coverageTitles: ['SP 21 2005', 'Gazette Notification'] });
  assert.match(html, /SP 21 2005/);
  assert.match(html, /Gazette Notification/);
});

test('coverage list escapes document titles', () => {
  // Titles come from filenames, which are user input.
  const html = renderCoverageHtml(['<img src=x onerror=alert(1)>'], 'en');
  assert.ok(!html.includes('<img'), 'unescaped title reached innerHTML');
  assert.match(html, /&lt;img/);
});

test('greeting reply is localised and lists coverage', () => {
  const html = renderGreetingHtml({ lang: 'te', coverageTitles: ['SP 21 2005'] });
  assert.ok(/[ఀ-౿]/.test(html), 'Telugu greeting contains no Telugu');
  assert.match(html, /SP 21 2005/);
});

test('an empty corpus omits the coverage section rather than showing a blank list', () => {
  const html = renderNotFoundHtml({ lang: 'en', coverageTitles: [] });
  assert.ok(!html.includes('Right now I can answer'), 'showed a coverage header with no documents');
});
