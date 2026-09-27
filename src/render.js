import {
  NOT_FOUND_REPLY,
  GROUNDING_NOTE,
  COVERAGE_HEADER,
  GREETING_REPLY,
  TRANSLATION_FAILED_REPLY,
  NEAR_MISS_LEAD,
  NEAR_MISS_HEADER,
  SUGGESTIONS_HEADER,
  LOCATED_LEAD,
  LOCATED_HEADER,
} from './prompts.js';
import { normaliseLang } from './translator.js';

/**
 * Escape model output before it reaches innerHTML.
 *
 * The frontend does `msgBubble.innerHTML = data.answer` and we are not
 * changing the frontend, so anything the model produces is untrusted markup.
 * The only HTML in the final response is what this file generates itself.
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The page reference inside a citation, linked to the real document.
 *
 * This is the part that makes a citation checkable. A page number the reader
 * cannot act on is only marginally better than no page number, and for a
 * standards assistant the whole claim is that the answer came from a specific
 * clause of a specific document.
 *
 * `pageFrom` is a 1-based PDF page index, which is exactly what the `#page=N`
 * fragment of every mainstream PDF viewer consumes, so the browser renders the
 * real page. It is *not* the folio printed on the page: that number is not in
 * the text layer at all (the front matter is roman-numbered and body pages carry
 * no extractable folio), so anyone reading a physical copy of SP 21 will be
 * looking at a different number. Worth remembering before treating these as book
 * page numbers.
 *
 * The fragment is only ever a page. Landing on the right page and having to find
 * the clause is the honest limit of this approach — a viewer cannot scroll to a
 * clause it does not know the position of, and faking that would mean
 * reimplementing a PDF renderer. The `content` panel beside it is what makes the
 * clause itself findable.
 *
 * A plain anchor, deliberately not a click handler: middle-click and ctrl-click
 * behave, it works with the styling stripped, and there is no JS to keep in sync
 * with the markup. `docId` is URL-encoded even though it comes from the database.
 *
 * The `data-*` attributes duplicate what the href already says. They exist so the
 * frontend can open the cited page in an in-page panel without re-parsing a URL,
 * and they are additive: with the script blocked the href still resolves. The
 * frontend is the only consumer; nothing here depends on them existing.
 *
 * Rendered as plain text when there is no document to point at, so a passage
 * never acquires a link that 404s. A link that looks verified and is not is worse
 * than no link.
 */
export function pageLink(p, label) {
  const text = escapeHtml(label);
  if (!p?.docId || !Number.isFinite(p.pageFrom)) return text;
  const page = Math.max(1, Math.trunc(p.pageFrom));
  // The passage, escaped, so the in-page viewer can show the evidence without a
  // second request. This escaping makes the *attribute* safe -- it is what stops a
  // passage containing a quote or a tag from breaking out of data-excerpt. It is
  // not what makes the clause findable: the frontend reads data-excerpt through
  // `dataset`, which resolves the entities again, and then has to re-escape before
  // assigning to innerHTML or a tag in the PDF text would become a live element in
  // the drawer. It re-escapes with esc(), so esc() and escapeHtml() have to replace
  // the same five characters the same way -- otherwise the drawer and this panel
  // would mark different spans for one citation. See markClause() in
  // BIS_Assistant_frontend.html.
  const excerpt = p.content ? escapeHtml(p.content) : '';
  return (
    `<a class="cite-link" href="/api/documents/${encodeURIComponent(p.docId)}/pdf#page=${page}" ` +
    `data-doc="${escapeHtml(p.docId)}" data-page="${page}" ` +
    `data-title="${escapeHtml(p.docTitle ?? '')}" data-clause="${escapeHtml(p.clause ?? '')}" ` +
    `data-excerpt="${excerpt}" target="_blank" rel="noopener">${text}</a>`
  );
}

/**
 * The passage text, with the cited clause marked, for checking a claim.
 *
 * The panel shows the exact chunk that was handed to the model, which is the
 * only copy of "the source" worth anything — a re-extracted or re-rendered copy
 * could differ from what was actually read, and then the panel would be
 * reassuring the user about the wrong text.
 *
 * Only the *first* occurrence of the clause is marked, and only when the clause
 * string genuinely appears in the text. Measured across the corpus, 91.5% of
 * chunks contain their clause somewhere (chunks are ~1200 characters and span
 * clause boundaries, so the clause is often mid-chunk rather than at the start).
 * The remaining 8.5% render unmarked, which is the correct outcome: a highlight on
 * the wrong span would tell the user they had found the clause when they had not.
 */
export function citationPanel(p, { label = 'Show the text this was taken from' } = {}) {
  const text = typeof p?.content === 'string' ? p.content.trim() : '';
  if (!text) return '';

  let body = escapeHtml(text);
  const clause = typeof p.clause === 'string' ? p.clause.trim() : '';
  if (clause) {
    const at = text.indexOf(clause);
    // Escape the clause for the same escaping as the body, then search the
    // *escaped* body, because the offsets only line up there. A clause like
    // "5.1 & 5.2" would otherwise mark a different span than it appears at.
    const needle = escapeHtml(clause);
    const found = body.indexOf(needle);
    if (found !== -1 && at !== -1) {
      body = body.slice(0, found) + '<mark>' + body.slice(found, found + needle.length) + '</mark>' + body.slice(found + needle.length);
    }
  }

  return (
    `<details class="cite-panel">` +
    `<summary class="cite-toggle">${escapeHtml(label)}</summary>` +
    `<div class="cite-excerpt">${body}</div>` +
    `</details>`
  );
}

/** Tidy model output: strip stray code fences, collapse blank runs. */
function normaliseModelText(raw) {
  return String(raw)
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function modelSaysNotFound(text) {
  const t = String(text).trim();
  return t === 'NOT_FOUND' || /^NOT_FOUND\b/i.test(t) || /\bNOT_FOUND\b/.test(t.slice(0, 80));
}

/**
 * Turn [[1]]-style markers into superscript citation links and turn newlines
 * into the paragraph/line breaks the chat bubble needs.
 */
function renderBody(text) {
  const escaped = escapeHtml(text);

  const withCitations = escaped.replace(/\[\[(\d{1,2})\]\]/g, (_, n) => {
    const idx = Number(n);
    if (idx < 1 || idx > 99) return '';
    return `<sup class="cite" title="Source ${idx}">[${idx}]</sup>`;
  });

  return withCitations
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return '';
      if (lines.every((l) => l.startsWith('- '))) {
        return `<ul style="margin:6px 0;padding-left:20px">${lines
          .map((l) => `<li>${l.slice(2)}</li>`)
          .join('')}</ul>`;
      }
      return `<p style="margin:0 0 8px">${lines.join('<br>')}</p>`;
    })
    .join('');
}

/**
 * Fill `{placeholder}` slots in a localised template.
 *
 * Substitution is not escaping — every caller still runs the result through
 * `escapeHtml`, because the values interpolated here include the user's own query.
 * The two steps are kept separate on purpose: escaping inside this function would
 * double-escape the parts of the template that are already plain text, and putting
 * `{query}` in without escaping it would be an injection straight into innerHTML.
 */
export function formatTemplate(table, lang, vars = {}) {
  const t = normaliseLang(lang);
  let out = table?.[t] ?? table?.en ?? '';
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value ?? ''));
  }
  return out;
}

/**
 * `answered from` was a claim, and the model does not support it.
 *
 * The tag was rendered on every source up to the count the generator was given,
 * which asserts that the answer came from that clause. But sarvam-1 does not
 * ground: asked about Indian bricks it answered with "BS EN1985-2017", a British
 * standard absent from this corpus, while the Sources block confidently labelled a
 * real SP 21 clause "answered from". That is the most damaging possible failure
 * for a traceability tool — it looks verified and is not.
 *
 * So the provenance claim is gone. What remains is factual: which passages were
 * retrieved, how they ranked, and how many were actually read by the generator.
 * `passedToModel` is passed from the same array handed to the model, so it cannot
 * drift. A stronger model that emits real `[[n]]` markers can restore a verified
 * link without another redesign — render.js already understands the marker.
 */
export function renderSourcesHtml(passages, lang = 'en', passedToModel = 0) {
  if (!passages.length) return '';

  const label = {
    en: 'Sources',
    hi: 'स्रोत',
    pa: 'ਸਰੋਤ',
    te: 'మూలాలు',
  }[lang] ?? 'Sources';

  const readTag = {
    en: 'read by model',
    hi: 'मॉडल द्वारा पढ़ा गया',
    pa: 'ਮਾਡਲ ਦੁਆਰਾ ਪੜ੍ਹਿਆ ਗਿਆ',
    te: 'మోడల్ చదివింది',
  }[lang] ?? 'read by model';

  // The disclosure that reveals the passage text. Translated because it sits in
  // the answer the user is reading, and an English instruction inside a Hindi
  // answer is the same mismatch that produced a Devanagari reply in an English
  // interface.
  const panelLabel = {
    en: 'Show the text this was taken from',
    hi: 'यह कहाँ से लिया गया, पाठ दिखाएँ',
    pa: 'ਦਿਖਾਓ ਇਹ ਕਿੱਥੋਂ ਲਿਆ ਗਿਆ',
    te: 'ఈ పాఠ్యం ఎక్కడి నుండి తీసుకున్నారో చూపించండి',
  };

  const items = passages
    .map((p, i) => {
      const pages = p.pageFrom === p.pageTo ? `p. ${p.pageFrom}` : `pp. ${p.pageFrom}–${p.pageTo}`;
      const clause = p.clause ? ` <span style="color:#1a56b5;font-weight:600">cl. ${escapeHtml(p.clause)}</span> ·` : '';
      const score = Math.round(p.similarity * 100);
      // Stated as a fact about the pipeline, not a claim about the prose.
      const read =
        i < passedToModel
          ? ` <span style="color:#6b7280;font-size:11px">(${readTag})</span>`
          : '';
      // Only the passages the generator actually read are evidence for the
      // answer. The rest were retrieved and ranked but never seen, so offering
      // their text for verification would be offering something the model did
      // not use.
      const panel = i < passedToModel ? citationPanel(p, { label: panelLabel[lang] ?? panelLabel.en }) : '';
      return `<li style="margin:3px 0"><span style="color:#1a56b5;font-weight:600">[${i + 1}]</span> ${escapeHtml(
        p.docTitle
      )}${clause} ${pageLink(p, pages)} <span style="opacity:.6;font-size:11px">(match ${score}%)${
        read
      }</span>${panel}</li>`;
    })
    .join('');


  return (
    `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #e5e7eb">` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.55;margin-bottom:6px">${label}</div>` +
    `<ol style="margin:0;padding-left:20px;font-size:12px;line-height:1.55">${items}</ol>` +
    `</div>`
  );
}

/**
 * Real topics, rendered as question chips.
 *
 * This is the payload that makes a dead end useful. Every entry is a standard
 * title parsed out of the indexed text, so the list cannot advertise a subject the
 * corpus lacks — the exact failure the old sidebar had, where certification,
 * laboratories and hallmarking were all offered and none of them existed in SP 21.
 *
 * Rendered as `<button>`s with the question in the text, so the frontend can
 * delegate one click handler and the reply is readable when the styling is
 * stripped or the markup is printed.
 */
export function renderSuggestionsHtml(topics, lang = 'en') {
  if (!topics?.length) return '';
  const l = normaliseLang(lang);
  const header = SUGGESTIONS_HEADER[l] ?? SUGGESTIONS_HEADER.en;

  const items = topics
    .map((t) => {
      const ask = `What is ${t.isCode} ${t.title}?`;
      return (
        `<li style="margin:4px 0">` +
        `<button type="button" class="ask-suggestion" data-ask="${escapeHtml(ask)}" ` +
        `style="background:none;border:none;padding:0;font:inherit;color:#1a56b5;text-align:left;cursor:pointer;text-decoration:underline">` +
        `${escapeHtml(t.title)} <span style="color:#6b7280;text-decoration:none">(${escapeHtml(t.isCode)})</span>` +
        `</button></li>`
      );
    })
    .join('');

  return (
    `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb">` +
    `<div style="font-size:12px;margin-bottom:5px">${escapeHtml(header)}</div>` +
    `<ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.5">${items}</ul>` +
    `</div>`
  );
}

/**
 * A short, honest excerpt of a passage, for the bridge reply.
 *
 * The first sentence of the chunk is usually the clause heading or its subject,
 * which is the most informative line available. Cut on a word boundary and capped
 * so the bridge stays a pointer rather than becoming a second answer the model did
 * not write.
 */
function passageExcerpt(content, maxChars = 180) {
  const text = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;

  const head = text.slice(0, maxChars);
  const lastSpace = head.lastIndexOf(' ');
  return `${(lastSpace > 40 ? head.slice(0, lastSpace) : head).trim()}…`;
}

/**
 * A refusal that says what the corpus *does* cover.
 *
 * "I could not find that" is technically true and practically useless: the user has
 * no way to learn the boundary except by guessing more queries. Listing the indexed
 * documents turns a dead end into something actionable — and it is generated from
 * the database, so it cannot drift from what is actually loaded.
 */
function renderCoverageHtml(titles, lang = 'en') {
  const l = normaliseLang(lang);
  if (!titles?.length) return '';

  const header = COVERAGE_HEADER[l] ?? COVERAGE_HEADER.en;
  const items = titles.map((t) => `<li style="margin:2px 0">${escapeHtml(t)}</li>`).join('');

  return (
    `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb">` +
    `<div style="font-size:12px;margin-bottom:5px">${escapeHtml(header)}</div>` +
    `<ul style="margin:0;padding-left:20px;font-size:12px;line-height:1.5;opacity:.85">${items}</ul>` +
    `</div>`
  );
}

/**
 * Total miss: nothing in the corpus resembles the question.
 *
 * Built from the query the user actually typed, the documents that are actually
 * loaded, and topics parsed out of the actual chunk text. Three different pieces
 * of real state, so no two misses read the same and none of them can claim a
 * subject the corpus does not contain.
 */
export function renderNotFoundHtml({
  lang = 'en',
  coverageTitles = [],
  passages = [],
  query = '',
  topics = [],
} = {}) {
  const l = normaliseLang(lang);
  return (
    `<p style="margin:0 0 8px">${escapeHtml(
      formatTemplate(NOT_FOUND_REPLY, l, { query: query || '—' })
    )}</p>` +
    renderSuggestionsHtml(topics, l) +
    renderCoverageHtml(coverageTitles, l) +
    `<p style="margin:10px 0 0;font-size:12px;opacity:.65">${escapeHtml(
      GROUNDING_NOTE[l] ?? GROUNDING_NOTE.en
    )}</p>` +
    renderSourcesHtml(passages, l)
  );
}

/**
 * Near miss: the corpus holds something adjacent, and it is shown rather than
 * described.
 *
 * This is the reply the whole banding change exists to make possible. Previously the
 * evidence between "no match" and "good match" was deleted in SQL, so the only
 * available response was a generic refusal. Now the nearest real clause is named —
 * with its number, its page and its own opening words — and the user can judge the
 * distance themselves instead of being told, without evidence, that nothing exists.
 */
export function renderNearMissHtml({
  lang = 'en',
  query = '',
  nearest = null,
  coverageTitles = [],
  topics = [],
} = {}) {
  const l = normaliseLang(lang);
  const lead = formatTemplate(NEAR_MISS_LEAD, l, { query: query || '—' });
  const header = NEAR_MISS_HEADER[l] ?? NEAR_MISS_HEADER.en;

  let block = `<p style="margin:0 0 8px">${escapeHtml(lead)}</p>`;

  if (nearest) {
    const pages =
      nearest.pageFrom === nearest.pageTo
        ? `p. ${nearest.pageFrom}`
        : `pp. ${nearest.pageFrom}–${nearest.pageTo}`;
    const score = Math.round(nearest.similarity * 100);
    block +=
      `<div style="margin:0 0 8px;padding:8px 10px;border-left:2px solid #cbd5e1;background:#f8fafc">` +
      `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.55;margin-bottom:4px">${escapeHtml(header)}</div>` +
      `<div style="font-size:12px;line-height:1.5">` +
      (nearest.clause
        ? `<span style="color:#1a56b5;font-weight:600">cl. ${escapeHtml(nearest.clause)}</span> · `
        : '') +
      `${pageLink(nearest, pages)} <span style="opacity:.6">(match ${score}%)</span><br>` +
      `${escapeHtml(passageExcerpt(nearest.content))}` +
      `</div></div>`;
  }

  return (
    block +
    renderSuggestionsHtml(topics, l) +
    renderCoverageHtml(coverageTitles, l)
  );
}

/**
 * A located entry, for a query that is a fragment rather than a question.
 *
 * "fly ash" retrieves the right clause — cl. 1.12, p. 24, which is the fly ash
 * entry — and the generator was asked to answer it anyway. It returned the literal
 * heading, "Fly Ash": five seconds of CPU for two words that told the user nothing
 * they had not typed. Worse, the reply *looked* like a successful answer, because
 * it came back on the answer path with a full Sources block.
 *
 * A bare noun is a lookup, not a question, so it gets located rather than answered.
 * The entry is shown with its clause, page and opening words, which is the thing the
 * user was trying to find, and it costs no generation at all.
 */
export function renderLocatedHtml({ lang = 'en', query = '', passages = [], coverageTitles = [], topics = [] } = {}) {
  const l = normaliseLang(lang);
  const lead = formatTemplate(LOCATED_LEAD, l, { query: query || '—' });
  const header = LOCATED_HEADER[l] ?? LOCATED_HEADER.en;

  const entries = passages
    .map((p) => {
      const pages = p.pageFrom === p.pageTo ? `p. ${p.pageFrom}` : `pp. ${p.pageFrom}–${p.pageTo}`;
      const score = Math.round(p.similarity * 100);
      return (
        `<li style="margin:6px 0">` +
        `<div style="font-size:11px;opacity:.65">` +
        (p.clause ? `<span style="color:#1a56b5;font-weight:600">cl. ${escapeHtml(p.clause)}</span> · ` : '') +
        `${pageLink(p, pages)} <span style="opacity:.6">(match ${score}%)</span></div>` +
        `<div style="font-size:13px;line-height:1.5">${escapeHtml(passageExcerpt(p.content, 260))}</div>` +
        `</li>`
      );
    })
    .join('');

  let block =
    `<p style="margin:0 0 8px">${escapeHtml(lead)}</p>` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.55;margin-bottom:6px">${escapeHtml(header)}</div>` +
    `<ul style="margin:0;padding-left:18px">${entries}</ul>`;

  return block + renderSuggestionsHtml(topics, l) + renderCoverageHtml(coverageTitles, l);
}

/** Greeting / thanks reply, with the coverage list and real topics. */
export function renderGreetingHtml({ lang = 'en', coverageTitles = [], topics = [] } = {}) {
  const l = normaliseLang(lang);
  return (
    `<p style="margin:0 0 8px">${escapeHtml(GREETING_REPLY[l] ?? GREETING_REPLY.en)}</p>` +
    renderCoverageHtml(coverageTitles, l) +
    renderSuggestionsHtml(topics, l)
  );
}

/** The query could not be translated, so nothing was retrieved. */
export function renderTranslationFailedHtml({ lang = 'en' } = {}) {
  const l = normaliseLang(lang);
  return `<p style="margin:0">${escapeHtml(TRANSLATION_FAILED_REPLY[l] ?? TRANSLATION_FAILED_REPLY.en)}</p>`;
}

/**
 * Build the single HTML string the frontend injects.
 *
 * `passages` is included even on a refusal, so a demo can show *which* passages
 * were retrieved and why the answer was declined.
 */
export function renderAnswerHtml({
  answerText,
  passages,
  lang = 'en',
  coverageTitles = [],
  passedToModel = passages.length,
  query = '',
  topics = [],
}) {
  const l = normaliseLang(lang);

  // The model declining is a real outcome, not an error. Route it to the near-miss
  // reply so the user gets the nearest clause and some topics rather than a bare
  // refusal — the evidence is in `passages` either way.
  if (modelSaysNotFound(answerText)) {
    return (
      renderNearMissHtml({
        lang: l,
        query,
        nearest: passages[0] ?? null,
        coverageTitles,
        topics,
      }) + renderSourcesHtml(passages, l, passedToModel)
    );
  }

  return renderBody(normaliseModelText(answerText)) + renderSourcesHtml(passages, l, passedToModel);
}

export { NOT_FOUND_REPLY };
