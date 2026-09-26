import fs from 'node:fs/promises';
import path from 'node:path';
import { getDocumentProxy, extractText } from 'unpdf';
import { config } from './config.js';

/**
 * Below this many characters of extracted text, a page is almost certainly a
 * scanned image with no text layer rather than a genuinely blank page.
 */
const MIN_CHARS_PER_REAL_PAGE = 80;

/** "IS 14543:2024" / "IS 16102 (Part 1):2012" — the standard's own designation. */
const IS_CODE = /\bIS\s*\d{2,5}\s*(?:\([^)]*\))?\s*(?::|\b)\s*\d{4}\b/;

/**
 * Turn a PDF filename into a human title, e.g.
 *   "is-14543-2024-packaged-drinking-water.pdf" -> "IS 14543:2024 Packaged Drinking Water"
 *   "is16102-part-1-2012.pdf"                   -> "IS 16102 Part 1:2012"
 *
 * A hyphenated filename splits the designation into separate words ("is",
 * "14543", "2024"), so the "is" marker has to be rejoined with the number that
 * follows it before the year is attached.
 */
export function titleFromFilename(file) {
  const base = path.basename(file, path.extname(file));
  const words = base
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');

  const out = [];
  // Index of the most recent "IS <number>" token, so a trailing year can be
  // attached to it even when a "Part 1" sits in between ("is16102-part-1-2012").
  let isCodeIndex = -1;
  // BIS writes a part *inside* the designation — "IS 16102 (Part 1):2012" — so the
  // part words are held back and folded into the code rather than being emitted
  // as separate words, which used to yield the wrong "IS 16102:2012 Part 1".
  let partNumber = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lower = w.toLowerCase();

    // "is" standing alone, immediately followed by the standard number.
    if (lower === 'is' && i + 1 < words.length && /^\d{2,5}$/.test(words[i + 1])) {
      out.push(`IS ${words[i + 1]}`);
      isCodeIndex = out.length - 1;
      i++;
      continue;
    }

    // "is14543" written without a separator.
    const glued = /^is(\d{2,5})$/i.exec(w);
    if (glued) {
      out.push(`IS ${glued[1]}`);
      isCodeIndex = out.length - 1;
      continue;
    }

    // "part 1" belongs to the designation, not to the title words.
    if (lower === 'part' && i + 1 < words.length && /^\d+$/.test(words[i + 1])) {
      partNumber = words[i + 1];
      i++;
      continue;
    }

    out.push(w.charAt(0).toUpperCase() + w.slice(1));
  }

  // BIS writes the year after a colon on the designation itself:
  // "IS 14543" + "2024" -> "IS 14543:2024".
  for (let i = 0; i < out.length; i++) {
    if (isCodeIndex >= 0 && i > isCodeIndex && /^\d{4}$/.test(out[i])) {
      const designation = partNumber ? `${out[isCodeIndex]} (Part ${partNumber})` : out[isCodeIndex];
      out[isCodeIndex] = `${designation}:${out[i]}`;
      out.splice(i, 1);
      break;
    }
  }

  return out.join(' ');
}

/**
 * Extract text page by page.
 *
 * unpdf's extractText returns one string per page when `mergePages` is left
 * unset, which is exactly the granularity needed for page-accurate citations.
 * Merge-then-split was rejected: clause and page boundaries get destroyed and
 * the citation story is the whole point of this project.
 */
export async function extractPdfPages(filePath) {
  const buffer = await fs.readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));

  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  if (!Array.isArray(text)) {
    throw new Error(`Expected per-page text array for ${filePath}, got ${typeof text}`);
  }

  const pages = [];
  let sparsePages = 0;

  for (let i = 0; i < totalPages; i++) {
    const cleaned = normaliseWhitespace(text[i] ?? '');
    if (cleaned.length < MIN_CHARS_PER_REAL_PAGE) sparsePages++;
    pages.push({ pageNumber: i + 1, text: cleaned });
  }

  const totalChars = pages.reduce((s, p) => s + p.text.length, 0);
  // A document where most pages are thin is a scan. Flag it loudly, because
  // ingesting it produces a vector store that silently answers questions wrong.
  const isScanned = totalPages > 0 && sparsePages / totalPages > 0.5;

  return {
    pages,
    totalPages,
    totalChars,
    sparsePages,
    isScanned,
  };
}

/**
 * PDF text layers are messy: soft hyphens, ligatures, non-breaking spaces,
 * hard line-wraps mid-sentence, running headers/footers, and page numbers.
 */
function normaliseWhitespace(raw) {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '') // soft hyphen
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

/**
 * Strip repeating running headers, footers and bare page numbers.
 *
 * BIS standards repeat a header on every page ("IS 14543:2024"). Left in, those
 * lines land in dozens of chunks and drag unrelated queries toward whichever
 * document repeats its title most often.
 */
export function stripRunningHeads(pages) {
  const counts = new Map();
  const bump = (line) => counts.set(line, (counts.get(line) ?? 0) + 1);

  for (const { text } of pages) {
    const lines = text.split('\n');
    // Only edges of the page are candidates for running heads.
    for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      if (line.length > 0 && line.length < 120) bump(line);
    }
  }

  // A header that shows up on a third or more of pages is furniture, not content.
  const cutoff = Math.max(2, Math.floor(pages.length / 3));
  const isFurniture = (line) => {
    if (/^(page\s+)?\d+(\s+of\s+\d+)?$/i.test(line)) return true;
    if (IS_CODE.test(line) && line.length < 80) return true;
    return (counts.get(line) ?? 0) >= cutoff;
  };

  return pages.map((p) => ({
    ...p,
    text: p.text
      .split('\n')
      .filter((line) => !isFurniture(line))
      .join('\n')
      .trim(),
  }));
}

/** List the PDFs in the corpus directory, sorted for deterministic ingest. */
export async function listPdfs(dir = config.corpus.pdfDir, exclude = config.corpus.exclude) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const filtered = exclude.length
    ? entries.filter((f) => !exclude.some((needle) => f.toLowerCase().includes(needle)))
    : entries;

  return filtered
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Best-effort title: prefer an IS code found inside the document itself. */
/**
 * Front-matter lines that are set in capitals but are not the title.
 *
 * Every BIS publication opens with an RTI disclosure, a copyright line, an
 * imprint address and a foreword, all in the same uppercase title-block style as
 * the real title. Without this list the refiner picks "Disclosure to Promote the
 * Right To Information" as the document's name, which is worse than no refinement
 * at all.
 */
const TITLE_BLOCK_NOISE =
  /^(disclosure|whereas|©|copyright|bureau of indian standards|manak bhavan|new delhi|price|first published|first revision|published by|printed by|foreword|contents|preface|introduction|committee|composition|composition of|representing members|udc|isbn|all rights|reproduction|edition|year of|print)/i;

/** A line is title-block material if it is mostly capitals and long enough to be a title. */
function isTitleLine(line) {
  const t = line.trim();
  if (t.length < 3 || t.length > 120) return false;
  if (TITLE_BLOCK_NOISE.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  return letters === letters.toUpperCase();
}

/**
 * Find a printed title block in the front matter.
 *
 * Handbooks and "summaries of standards" compilations — SP 21 here — carry their
 * real name on a title page a few pages in, set as a run of capital lines:
 *
 *   SUMMARIES OF INDIAN STANDARDS
 *   FOR
 *   BUILDING MATERIALS
 *
 * The old refiner only read three pages looking for an "IS <n>:<year>" code, so
 * it missed this entirely and fell back to the filename, producing the title
 * "Is Sp 21 2005". These compilations are not IS standards at all; they are SP
 * publications that summarise many of them, so there is no code to find.
 *
 * Returns the joined, title-cased name, or null when there is no title block.
 */
function findTitleBlock(pages) {
  // Page 0-11 covers the RTI notice, title page, copyright and contents. Beyond
  // that the front matter is over and capitals start meaning something else.
  //
  // A table of contents does not need special handling: its category headings are
  // interleaved with the IS entries beneath them, and those entries are
  // sentence-cased, so they break every run before it reaches two lines.
  for (const page of pages.slice(0, 12)) {
    const lines = page.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    let run = [];
    for (const line of lines) {
      if (isTitleLine(line)) {
        run.push(line);
        continue;
      }
      if (run.length >= 2) break; // a title block is a run, then prose begins
      run = [];
    }
    if (run.length >= 2) {
      const joined = run
        .join(' ')
        .replace(/\bFOR\b/g, 'for')
        .replace(/\s+/g, ' ')
        .trim();
      return toTitleCase(joined);
    }
  }
  return null;
}

/** "SUMMARIES OF INDIAN STANDARDS" -> "Summaries of Indian Standards". */
function toTitleCase(s) {
  const small = new Set([
    'for', 'of', 'and', 'the', 'in', 'on', 'to', 'a', 'an', 'or', 'by', 'at', 'from', 'with', 'for',
  ]);
  return s
    .split(' ')
    .map((w, i) => {
      const bare = w.replace(/[^A-Za-z]/g, '');
      // Keep genuine acronyms (BIS, SP, CED) and anything carrying digits, but
      // only when they are short. Testing for "two capitals in a row" instead
      // would preserve every word of a title that is set in caps, which is the
      // normal case for a title page.
      // Small words are checked first: "OF" and "FOR" are two capitals in a row
      // and would otherwise qualify as acronyms.
      if (small.has(w.toLowerCase())) return w.toLowerCase();

      const isAcronym = bare.length <= 3 && bare === bare.toUpperCase() && /[A-Z]/.test(bare);
      if (isAcronym) return w;
      if (/\d/.test(w)) return w;

      const head = w[0].toUpperCase();
      // A word that arrives entirely in capitals came off a title page, so its
      // tail must be lowered or "SUMMARIES" stays "SUMMARIES". A word that is
      // already mixed case is left alone apart from its first letter, so a
      // legitimately capitalised "Indian" does not become "INDIAN".
      return bare === bare.toUpperCase() ? head + w.slice(1).toLowerCase() : head + w.slice(1);
    })
    .join(' ');
}

/** "SP 21" style designations, as used by BIS handbooks and compilations. */
const SP_CODE = /\bSP\s*-?\s*(\d{1,3})\b/i;

export function refineTitleFromContent(fallbackTitle, pages) {
  const head = pages
    .slice(0, 3)
    .map((p) => p.text)
    .join('\n')
    .slice(0, 4000);

  // A plain IS standard states its own designation on page 1; trust that.
  const m = IS_CODE.exec(head);
  if (m) return m[0].replace(/\s+/g, ' ').trim();

  const block = findTitleBlock(pages);
  if (!block) return fallbackTitle;

  // Prefix the designation when the document names one and the title does not
  // already carry it, so the corpus lists "SP 21 — Summaries of ..." rather than
  // a bare sentence that looks like a section heading.
  //
  // The filename counts as a source: "is.sp.21.2005.pdf" is how the designation
  // usually arrives, since the title page of a compilation often never prints it.
  const sp =
    SP_CODE.exec(pages.slice(0, 12).map((p) => p.text).join('\n')) ?? SP_CODE.exec(fallbackTitle);
  if (sp && !SP_CODE.test(block)) {
    return `SP ${sp[1]} — ${block}`;
  }
  return block;
}
