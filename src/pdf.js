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

    out.push(w.charAt(0).toUpperCase() + w.slice(1));
  }

  // BIS writes the year after a colon on the designation itself:
  // "IS 14543" + "2024" -> "IS 14543:2024".
  for (let i = 0; i < out.length; i++) {
    if (isCodeIndex >= 0 && i > isCodeIndex && /^\d{4}$/.test(out[i])) {
      out[isCodeIndex] = `${out[isCodeIndex]}:${out[i]}`;
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
export function refineTitleFromContent(fallbackTitle, pages) {
  const head = pages
    .slice(0, 3)
    .map((p) => p.text)
    .join('\n')
    .slice(0, 4000);

  const m = IS_CODE.exec(head);
  if (!m) return fallbackTitle;
  return m[0].replace(/\s+/g, ' ').trim();
}
