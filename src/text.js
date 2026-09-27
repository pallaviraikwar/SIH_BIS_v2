/**
 * Text: identifying a standard, and cleaning up a title.
 *
 * Pure string work with no database, kept out of store.js for the same reason as
 * rank.js. `parseIsIdentifier` and `passageHasIdentifier` are the rules for what
 * counts as a standard reference, which is domain knowledge rather than storage;
 * `tidyTitle` is a repair function for standard titles, and the comment on
 * `corpusTopics` in store.js is the other half of that story.
 */

export function tidyTitle(raw, truncated = false) {
  let t = String(raw ?? '')
    .replace(/IS\s+[0-9]{2,6}\s*:\s*[0-9]{4}\s+/i, '')
    .replace(/\s*[-–—:;,]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Drop revision notes. SP 21 writes these inline — "...enamels (second
  // revision)" — and they are index metadata, not part of what the standard is
  // about, so they make poor suggestions.
  //
  // Stripped anywhere in the title, not just at the end: when the 100-character
  // cap lands mid-title the note is left stranded in the middle, e.g. "...
  // supplies (first revision) Part I General".
  //
  // Whether the strip succeeded matters below, so compare rather than assign
  // blind.
  const withoutRevisionNote = t
    .replace(/\s*\(\s*(?:first|second|third|fourth|fifth)?\s*revision\s*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const hadRevisionNote = withoutRevisionNote !== t;
  t = withoutRevisionNote;

  // Only repair a cut, and only when the pattern really did cut one.
  //
  // The character cap in IS_TITLE_PATTERN is unavoidable: titles are followed by
  // descriptive prose with no delimiter, so something has to stop the match. But
  // repairing unconditionally mangles every naturally short title — an earlier
  // version turned "Specification for clay paving bricks" into "Specification for
  // clay paving" because it trimmed at the last space regardless. `truncated` is
  // the caller's signal that the overflow group matched, i.e. the cap did the cut.
  if (!truncated) return t.length >= 12 ? t : '';

  // Cut back to a whole word, but only if something is still actually left
  // dangling. Two separate bugs lived in here:
  //
  //  - Cutting inside the repair loop made each pass trim an already-aligned
  //    string again, one word per pass, until "Low density polyethylene pipes for
  //    potable water supp" became "Low density polyethylene pipes".
  //  - Cutting unconditionally after the revision-note strip cost another word,
  //    because the strip had just left the string cleanly word-aligned: "...paints
  //    and enamels (second revision)" lost " and enamels".
  //
  // A complete trailing parenthetical is a whole token, so removing it leaves
  // nothing to repair. Only cut when no strip realigned things.
  if (!hadRevisionNote) {
    const lastSpace = t.lastIndexOf(' ');
    if (lastSpace > 24) t = t.slice(0, lastSpace);
  }

  // Then repair to a fixpoint: an unbalanced bracket and a dangling function word
  // can each expose the other, and a cap that severed a trailing "(second" is
  // repaired here. Bounded so a pathological input cannot spin.
  for (let pass = 0; pass < 4; pass++) {
    const before = t;

    // A trailing parenthetical still open at the end is a severed note.
    const open = t.indexOf('(');
    if (open !== -1 && t.indexOf(')', open) === -1) t = t.slice(0, open);

    // A dangling function word is what a mid-phrase cut usually leaves.
    t = t.replace(/\s+(for|of|and|or|the|to|in|with|on|at|by|from)$/i, '');

    t = t.replace(/\s*[-–—:;,]\s*$/, '').trim();
    if (t === before) break;
  }

  return t.length >= 12 ? t : '';
}

/**
 * A stable-per-query, non-repeating slice of the corpus topics.
 *
 * The rotation matters: always suggesting the same six titles means a user who
 * rejects all six has learned there is nothing else to try. Seeding the shuffle
 * from the query means the same question always yields the same suggestions —
 * stable under refresh, which a random shuffle would not be — while different
 * questions explore different parts of the corpus.
 */
export function rotateTopics(topics, seed = '') {
  if (topics.length <= 1) return topics;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const start = Math.abs(h) % topics.length;
  return [...topics.slice(start), ...topics.slice(0, start)];
}

/**
 * The standard identifier a query is asking about, if it names one.
 *
 * "IS 456", "is 456:2000" and "IS 10262 : 2019" all name a specific standard, and
 * finding the clause that actually prints that identifier is a lookup, not a
 * similarity judgement. The identifier is normalised to digits-and-year so the
 * spacing variants in the corpus ("IS1 3360", "IS 3583:1988") still compare equal.
 *
 * Returns null for anything that is not an identifier, which is what keeps the band
 * promotion narrow: a common-word tsvector hit must never be able to lift a reply
 * into the answer band on its own.
 */
export function parseIsIdentifier(query) {
  const m = String(query ?? '').match(/\bIS\s*:?\s*(\d{2,6})\s*(?::\s*(\d{4}))?/i);
  if (!m) return null;
  return { code: m[1], year: m[2] ?? null };
}

/**
 * Whether a passage actually prints the identifier the query named.
 *
 * A containment test on the digit sequence, not on the formatted string, because
 * the corpus is inconsistent about spacing and the year separator: "IS 456",
 * "IS 456:2000" and "IS 456 : 2000" all appear, and one malformed extraction should
 * not decide the band.
 */
export function passageHasIdentifier(passage, identifier) {
  if (!identifier) return false;
  const text = String(passage?.content ?? '');
  if (!new RegExp(`\\b${identifier.code}\\b`).test(text)) return false;
  if (identifier.year && !text.includes(identifier.year)) return false;
  return true;
}
