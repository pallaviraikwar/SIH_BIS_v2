import {
  NOT_FOUND_REPLY,
  GROUNDING_NOTE,
  COVERAGE_HEADER,
  GREETING_REPLY,
  TRANSLATION_FAILED_REPLY,
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

export function renderSourcesHtml(passages, lang = 'en') {
  if (!passages.length) return '';

  const label = {
    en: 'Sources',
    hi: 'स्रोत',
    pa: 'ਸਰੋਤ',
    te: 'మూలాలు',
  }[lang] ?? 'Sources';

  const items = passages
    .map((p, i) => {
      const pages = p.pageFrom === p.pageTo ? `p. ${p.pageFrom}` : `pp. ${p.pageFrom}–${p.pageTo}`;
      const clause = p.clause ? ` <span style="color:#1a56b5;font-weight:600">cl. ${escapeHtml(p.clause)}</span> ·` : '';
      const score = Math.round(p.similarity * 100);
      return `<li style="margin:3px 0"><span style="color:#1a56b5;font-weight:600">[${i + 1}]</span> ${escapeHtml(
        p.docTitle
      )}${clause} ${pages} <span style="opacity:.6;font-size:11px">(match ${score}%)</span></li>`;
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
 * A refusal that says what the corpus *does* cover.
 *
 * "I could not find that" is technically true and practically useless: the user
 * has no way to learn the boundary except by guessing more queries. Listing the
 * indexed documents turns a dead end into something actionable — and it is
 * generated from the database, so it cannot drift from what is actually loaded.
 */
export function renderCoverageHtml(titles, lang = 'en') {
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

/** Localised "not found" block, optionally followed by the coverage list. */
export function renderNotFoundHtml({ lang = 'en', coverageTitles = [], passages = [] } = {}) {
  const l = normaliseLang(lang);
  return (
    `<p style="margin:0 0 8px">${escapeHtml(NOT_FOUND_REPLY[l] ?? NOT_FOUND_REPLY.en)}</p>` +
    `<p style="margin:0;font-size:12px;opacity:.65">${escapeHtml(GROUNDING_NOTE[l] ?? GROUNDING_NOTE.en)}</p>` +
    renderCoverageHtml(coverageTitles, l) +
    renderSourcesHtml(passages, l)
  );
}

/** Greeting / thanks reply with the coverage list. */
export function renderGreetingHtml({ lang = 'en', coverageTitles = [] } = {}) {
  const l = normaliseLang(lang);
  return (
    `<p style="margin:0 0 8px">${escapeHtml(GREETING_REPLY[l] ?? GREETING_REPLY.en)}</p>` +
    renderCoverageHtml(coverageTitles, l)
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
export function renderAnswerHtml({ answerText, passages, lang = 'en', coverageTitles = [] }) {
  const l = normaliseLang(lang);

  if (modelSaysNotFound(answerText)) {
    return renderNotFoundHtml({ lang: l, coverageTitles, passages });
  }

  return renderBody(normaliseModelText(answerText)) + renderSourcesHtml(passages, l);
}

export { NOT_FOUND_REPLY };
