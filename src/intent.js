/**
 * Chit-chat detection.
 *
 * Greetings are the worst case for a similarity threshold, and not because they
 * are unusual. On this corpus they score *highest* of all out-of-corpus input:
 * measured top-1 similarity was 0.6056 for "hi", 0.5947 for "hello", 0.5943 for
 * "help" — all higher than any product question, and "hi" actually cleared the
 * configured 0.60 threshold and retrieved a chunk of BIS Rules 2018. A short,
 * semantically empty string embeds near the centroid of generic prose, so it
 * lands close to everything and far from nothing.
 *
 * Raising the threshold cannot fix this without also rejecting real questions,
 * because the two distributions genuinely overlap at the low end. So greetings
 * are handled before retrieval: no embedding call, no threshold, no risk.
 */

const MAX_CHITCHAT_CHARS = 24;

/**
 * Matched against the *whole* normalised query, never as a substring.
 *
 * Substring matching would swallow real questions: "what is the hi-fi
 * requirement" and "how does the help desk work" both contain a greeting token.
 * Requiring an exact match after normalisation keeps the blast radius to
 * "someone said hi".
 */
const CHITCHAT = new Set([
  'hi', 'hii', 'hiii', 'hey', 'heya', 'hello', 'helo', 'hellowe', 'helloo',
  'yo', 'sup', 'ok', 'okay', 'k', 'cool', 'nice', 'great', 'awesome',
  'thanks', 'thank you', 'thx', 'ty', 'cheers',
  'bye', 'goodbye', 'see you', 'good night', 'good morning', 'good afternoon',
  'good evening',
  'help', 'test', 'testing', 'asdf', 'asdfgh', 'asdfghjkl',
  'who are you', 'what are you', 'what can you do', 'what do you do',
  'how are you', 'are you there', 'anyone there', 'any body there',
  'tell me about yourself', 'introduce yourself',
]);

/**
 * Lowercase, strip punctuation and emoji, collapse whitespace.
 *
 * Users type "Hi!", "hello :)", "Heyyy", and frequently misspell — "hellowe" is
 * in the set precisely because a typo must not be answered with a paragraph
 * about committee procedure.
 */
function normaliseChitChat(raw) {
  return String(raw ?? '')
    .toLowerCase()
    // Emoji and pictographs, then anything that is not a letter, mark, digit or
    // space. \p{M} matters: Devanagari vowel signs are combining marks, not
    // letters, so a letters-only filter silently shreds Hindi into consonants
    // ("गुड मॉर्निंग" -> "ग ड म र न ग") and would mangle every non-Latin greeting.
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The intent a query maps to, or null when it looks like a real question.
 *
 * Kept deliberately small and explicit. A fuzzy classifier here would be one
 * more thing to tune against a corpus it cannot see, and the failure mode is
 * bad: a real question silently answered with "hi, I cover these documents".
 */
export function detectIntent(raw) {
  const text = normaliseChitChat(raw);
  if (!text || text.length > MAX_CHITCHAT_CHARS) return null;
  if (CHITCHAT.has(text)) return 'chitchat';

  // Collapse lengthened greetings: "heyyyyy" and "hiiii" are the same intent.
  const collapsed = text.replace(/(.)\1{2,}/g, '$1');
  if (collapsed !== text && CHITCHAT.has(collapsed)) return 'chitchat';

  return null;
}
