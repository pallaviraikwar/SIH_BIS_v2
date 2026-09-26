import { config } from './config.js';

/**
 * Clause numbering as BIS standards write it:
 *   "5"  "5.2"  "5.2.1"  "6.1.3.2"  plus "Annex A", "Appendix 1", "Table 2"
 * Anchored to the start of a line because BIS standards number headings, not
 * inline prose. A bare number mid-sentence is a measurement, not a clause.
 */
const CLAUSE_HEAD = /^\s*(\d+(?:\.\d+)*)\s*[.)]?\s+(?=\S)/;
const ANNEX_HEAD = /^\s*(annex|appendix)\s+([A-Z]{1,2}|[0-9]+)\b\s*[.:)]?\s*(.*)$/i;
const TABLE_HEAD = /^\s*(table)\s+(\d+[A-Z]?)\b\s*[.:)]?\s*(.*)$/i;

/**
 * Group a page's lines into paragraph blocks.
 *
 * PDF text extraction emits one line per text item with NO blank lines between
 * paragraphs, so splitting on `\n{2,}` alone yields one block per page — which
 * destroys clause tracking and makes every chunk a whole page. Blank lines are
 * treated as an empty line and therefore just a boundary; the real signal is
 * structure: a heading starts a block, and so does the line after a
 * sentence-final.
 */
function toBlocks(pageText, pageNumber) {
  if (!pageText) return [];

  const lines = pageText.split('\n');
  const out = [];
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text) out.push({ text, pageNumber });
    buffer = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }

    if (buffer.length === 0) {
      buffer.push(t);
      continue;
    }

    const prev = buffer[buffer.length - 1];
    const startsNewBlock = classifyHeading(t) !== null || /[.!?:;]["')\]]?$/.test(prev);

    if (startsNewBlock) flush();
    buffer.push(t);
  }

  flush();
  return out;
}

/** Identify a clause number, annex, or table heading at the start of a block. */
function classifyHeading(text) {
  const annex = ANNEX_HEAD.exec(text);
  if (annex) {
    return { kind: 'annex', label: `${annex[1]} ${annex[2]}`.trim(), title: annex[3]?.trim() || '' };
  }
  const table = TABLE_HEAD.exec(text);
  if (table) {
    return { kind: 'table', label: `${table[1]} ${table[2]}`, title: table[3]?.trim() || '' };
  }
  const clause = CLAUSE_HEAD.exec(text);
  if (clause) {
    return { kind: 'clause', label: clause[1], title: text.replace(clause[0], '').slice(0, 120).trim() };
  }
  return null;
}

/**
 * A block that is nothing but a heading, e.g. "5 REQUIREMENTS" or "5.1 Moisture".
 *
 * `classifyHeading` matches on the block's first characters, so a block like
 * "5.1 Moisture The moisture content shall not exceed 6.0 percent by mass." also
 * classifies as a heading while actually carrying the requirement body. Only
 * short ones are treated as bare headings; that distinction is what lets clause
 * boundaries break chunks correctly.
 */
const BARE_HEADING_MAX_CHARS = 40;

function isBareHeading(text) {
  return classifyHeading(text) !== null && text.length < BARE_HEADING_MAX_CHARS;
}

/* ------------------------------------------------------------------ *
 * Table-row detection
 *
 * Real BIS documents are full of tables, and a table row often *starts*
 * with a number: "6. IS 158:2015 1 litre ... Rs 60,000.00 ...". The
 * clause regex cannot tell that apart from a real "6.2 Packaging"
 * heading, so every fee row was treated as a clause boundary and got
 * flushed into its own ~85-character chunk. That produced 4,126
 * near-worthless fragments across two fee-schedule PDFs, and each one
 * would have cost a Gemini embedding call.
 *
 * A row is distinguished from a heading by what follows the number: a
 * heading continues into words, a row continues into *figures*. Letter
 * density alone is not enough — Devanagari glyphs count as letters, so
 * Hindi fee rows sit at ~0.75 density, well above English prose. The
 * reliable signal is currency and a pile of numbers.
 * ------------------------------------------------------------------ */

const CURRENCY = /[\u20B9$€£¥]/u;
const CURRENCY_WORD = /\b(?:rs\.?|inr|usd|eur|gbp)\b/i;
const NUMERIC_TOKEN = /\d+(?:[.,]\d+)*/g;
const NON_LETTER = /[\d\s.,:;()[\]{}\/\\%+\-\u2013\u2014\u20B9$€£¥*#&@!?=]/gu;

function letterDensity(text) {
  const stripped = text.replace(NON_LETTER, '');
  const letters = stripped.match(/\p{L}/gu);
  return (letters ? letters.length : 0) / Math.max(stripped.length, 1);
}

/** Share of the block taken up by digits, so "Rs 60,000.00" counts as a figure. */
function digitRatio(text) {
  const digits = (text.match(NUMERIC_TOKEN) || []).join('').length;
  return digits / Math.max(text.length, 1);
}

/**
 * True when a block is a tabular data row rather than a clause heading.
 *
 * The currency *symbol* alone is not enough: plenty of tables spell the unit
 * out ("Rs 60,000.00"), and "Rs" counts as letters, which leaves such rows at
 * letter density 1.0 — indistinguishable from prose by density alone. So a row
 * is recognised by figures dominating the block: many numeric tokens, digits
 * eating a large share of the text, or an explicit currency marker.
 *
 * Verified against the corpus: 0 of 536 chunks across the 7 English documents
 * match, while 4,126 of the 5,687 Hindi fee-row chunks do.
 */
function looksLikeTableRow(text) {
  if (CURRENCY.test(text)) return true;

  const nums = text.match(NUMERIC_TOKEN) || [];
  if (nums.length >= 3 && letterDensity(text) < 0.5) return true;
  if (nums.length >= 4 && digitRatio(text) >= 0.3) return true;
  if (CURRENCY_WORD.test(text) && digitRatio(text) >= 0.2) return true;

  return letterDensity(text) < 0.35;
}

/**
 * Build chunks from per-page text.
 *
 * Design notes:
 * - Chunks never span a gap in page numbers; a chunk is page-coherent so its
 *   page citation is meaningful.
 * - Overlap is applied on block boundaries and capped by character count, so
 *   the same sentence is never cut in half at the seam.
 * - `clause` is the clause in force at the chunk's *start*, which is the clause
 *   a reader would use to find it.
 */
export function chunkDocument({ docId, docTitle, pages }, opts = {}) {
  const targetChars = opts.chars ?? config.chunk.chars;
  const overlap = opts.overlap ?? config.chunk.overlap;
  // Minimum size before a clause boundary is allowed to seal a chunk.
  //
  // Sealing on every clause is what gives precise citations, but a technical
  // standard is mostly short numbered requirements ("9.2 Wall thickness ERW Pipe
  // +/- 10 percent ..."), and sealing on all of them shredded a 929-page standard
  // into 7,222 fragments averaging 261 characters — 7,222 embedding calls, most
  // of them too small to retrieve well. Requiring the chunk being sealed to
  // already hold real text keeps boundaries meaningful without producing stubs.
  const minSealChars = opts.minSealChars ?? config.chunk.minSealChars;

  const blocks = pages.flatMap((p) => toBlocks(p.text, p.pageNumber));

  if (!blocks.length) return [];

  // Scale the floor to the document so it can never dominate a small one.
  //
  // The floor exists because a 929-page standard offers thousands of clause
  // boundaries and sealing on all of them produces thousands of stubs. But a
  // 300-char standard has the same boundaries at no real cost, and applying a
  // flat 600-char floor there would merge the entire document into one chunk and
  // destroy exactly the per-requirement citations this chunker exists to give.
  // Capping it at 2% of the document keeps the floor meaningful on big inputs
  // and inert on small ones.
  const totalDocChars = blocks.reduce((s, b) => s + b.text.length, 0);
  const effectiveMinSeal = Math.min(minSealChars, totalDocChars / 50);

  const chunks = [];
  let current = [];
  let currentChars = 0;
  // Whether the chunk being built contains any prose. A chunk that is still
  // nothing but headings is allowed to absorb the next heading, which keeps bare
  // section titles like "5 REQUIREMENTS" from becoming their own 14-char chunk
  // while still letting the following sub-clause set the citation.
  let currentHasProse = false;
  // The clause in force as the document is walked...
  let lastKnownClause = null;
  // ...and the clause at the START of the chunk being built, which is the one a
  // reader would use to find it. Frozen at the start so a chunk is never cited
  // as whatever clause happened to come last.
  let chunkClause = null;
  let lastHeading = null;

  const clauseOf = (blockText) => {
    const h = classifyHeading(blockText);
    if (h && h.kind === 'clause') return h.label;
    return null;
  };

  const flush = () => {
    if (!current.length) return;

    const text = current.map((b) => b.text).join('\n\n');
    const pageFrom = current[0].pageNumber;
    const pageTo = current[current.length - 1].pageNumber;

    chunks.push({
      docId,
      docTitle,
      pageFrom,
      pageTo,
      clause: chunkClause,
      heading: lastHeading,
      chunkIndex: chunks.length,
      content: text,
    });

    const totalChars = currentChars;

    // Carry the tail of this chunk into the next so a fact split across the
    // boundary is still retrievable from either side.
    //
    // Only worth doing for a chunk with real substance. A chunk shorter than
    // twice the overlap target would be carried forward almost in full (blocks
    // are indivisible, so a single 130-char paragraph would be copied whole),
    // making every following chunk open with the same text. That wastes context
    // and makes unrelated chunks look alike to the vector search — so short
    // chunks simply get no overlap.
    const maxTail = totalChars >= overlap * 2 ? overlap : 0;
    const tail = [];
    let tailChars = 0;
    // Stop at index 1, never 0. Blocks are indivisible, so the loop can overshoot
    // maxTail by up to one block — and when a block is bigger than the overlap
    // target the "tail" becomes the entire chunk, making the next chunk a
    // superset of this one. That is how 7.4% of chunks ended up as near-copies of
    // their predecessor: quota spent twice, and retrieval scoring the same text
    // twice. Never carrying block 0 guarantees the tail is strictly smaller than
    // the chunk it came from.
    for (let i = current.length - 1; i >= 1 && tailChars < maxTail; i--) {
      tail.unshift(current[i]);
      tailChars += current[i].text.length;
    }
    current = tail;
    currentChars = tailChars;
    currentHasProse = tail.some((b) => !isBareHeading(b.text));
  };

  for (const block of blocks) {
    // A data row that happens to start with a number is not a clause heading:
    // ignore it for heading detection and for clause tracking, so it neither
    // seals a chunk nor gets cited as "cl. 6".
    const isRow = looksLikeTableRow(block.text);
    const heading = isRow ? null : classifyHeading(block.text);

    if (heading) {
      lastHeading = heading.title || heading.label;
      if (heading.kind === 'clause' || heading.kind === 'annex') lastKnownClause = heading.label;
    }

    const blockClause = isRow ? null : clauseOf(block.text);
    if (blockClause) lastKnownClause = blockClause;

    const startsClause = Boolean(heading) && (heading.kind === 'clause' || heading.kind === 'annex');

    // A page break inside an accumulating chunk would make the page citation
    // misleading, so seal the chunk at the boundary instead.
    const pageBreak = current.length && current[current.length - 1].pageNumber !== block.pageNumber;

    // Prefer to seal a chunk on a clause boundary. Without this, a 1200-char
    // chunk happily spans clauses 1 through 5.2 and can only be cited as "cl. 1",
    // which is exactly the vague citation this project exists to avoid.
    const sealed =
      pageBreak ||
      (startsClause && currentHasProse && currentChars >= effectiveMinSeal) ||
      currentChars + block.text.length > targetChars;

    if (sealed) {
      flush();
      // After a flush `current` holds at most an overlap tail. If this block is
      // a heading it leads the new chunk regardless of that tail.
      chunkClause = startsClause ? heading.label : lastKnownClause;
      currentHasProse = false;
    } else if (current.length === 0) {
      chunkClause = lastKnownClause;
    } else if (startsClause && !currentHasProse) {
      // Absorbing a heading into a chunk that is still all headings.
      chunkClause = heading.label;
    }

    if (startsClause) lastHeading = heading.title || heading.label;

    // A single oversized block (a long table, usually) still has to be split.
    if (block.text.length > targetChars * 1.5) {
      for (const piece of hardSplit(block.text, targetChars)) {
        current.push({ text: piece, pageNumber: block.pageNumber });
        currentChars += piece.length;
        currentHasProse = true;
        flush();
      }
      continue;
    }

    current.push(block);
    currentChars += block.text.length;
    if (!isBareHeading(block.text)) currentHasProse = true;
  }

  flush();

  return chunks.map((c, i) => ({ ...c, chunkIndex: i }));
}

/** Last-resort splitter for a single block that is far longer than a chunk. */
function hardSplit(text, size) {
  const pieces = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('. ', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut <= 0) cut = size;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/**
 * Prefix the text that actually gets embedded with its own provenance.
 *
 * The stored `content` stays clean so citations read well, but the *embedded*
 * text carries "which standard, which page, which clause" — a chunk on its own
 * is an unlabelled fragment, and this is what stops a query about cement from
 * matching an identical-sounding biscuit clause.
 */
export function toEmbeddableText(chunk) {
  const bits = [chunk.docTitle];
  if (chunk.clause) bits.push(`clause ${chunk.clause}`);
  bits.push(`page ${chunk.pageFrom}`);
  if (chunk.heading) bits.push(`section: ${chunk.heading}`);

  return `[${bits.join(' | ')}]\n${chunk.content}`;
}
