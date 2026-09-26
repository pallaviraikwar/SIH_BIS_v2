import 'dotenv/config';
import path from 'node:path';

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export const EMBED_DIMS = num('EMBED_DIMS', 768);

export const config = {
  port: num('PORT', 3000),

  gemini: {
    apiKey: str('GEMINI_API_KEY', ''),
    embedModel: str('EMBED_MODEL', 'gemini-embedding-001'),
    genModel: str('GEN_MODEL', 'gemini-3.6-flash'),
    dims: EMBED_DIMS,
  },

  db: {
    connectionString: str('DATABASE_URL', 'postgres://bis:bis@127.0.0.1:5433/bis_rag'),
  },

  chunk: {
    chars: num('CHUNK_CHARS', 1200),
    overlap: num('CHUNK_OVERLAP', 200),
    // Smallest chunk worth sealing at a clause boundary for. A technical
    // standard is mostly short numbered requirements, and sealing on all of
    // them turned a 929-page document into 7,153 fragments averaging 211
    // characters — 7,153 embedding calls, most too small to retrieve well.
    minSealChars: num('CHUNK_MIN_SEAL_CHARS', 600),
  },

  retrieval: {
    topK: num('TOP_K', 5),
    // Corpus-specific, not universal. Measured against this repo's 6 regulatory
    // documents (536 chunks) with gemini-embedding-001 @768: in-corpus top-1
    // similarity ran 0.625-0.764 and off-topic 0.466-0.563, leaving a usable gap
    // of (0.563, 0.625]. The default sits in that gap, biased toward refusing,
    // because for a grounded assistant a wrong answer is worse than no answer.
    // Re-measure with /api/search?k=8&threshold=0 after any model, width, or
    // corpus change — stored vectors are only comparable within one of those.
    threshold: num('SIMILARITY_THRESHOLD', 0.6),
  },

  corpus: {
    pdfDir: path.resolve(process.cwd(), str('PDF_DIR', './data/pdfs')),
    schemaPath: path.resolve(process.cwd(), 'db/schema.sql'),
    // Case-insensitive substrings; a PDF whose basename contains any of them is
    // left out of ingestion. Lets a whole document be parked in the folder
    // without moving files, so it can be switched back on by editing one line.
    exclude: str('PDF_EXCLUDE', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  // pgvector's HNSW/IVFFlat index types refuse to index vectors wider than
  // 2000 dimensions. Gemini's default embedding width is 3072, so the schema
  // is pinned to 768. Refuse a misconfiguration here rather than at index time.
  pgvectorMaxIndexedDims: 2000,
};

export const SUPPORTED_LANGS = ['en', 'hi', 'pa', 'te'];

export function assertConfig() {
  const problems = [];

  if (!config.gemini.apiKey) {
    problems.push('GEMINI_API_KEY is missing. Add it to .env (cp .env.example .env).');
  }
  if (config.gemini.dims > config.pgvectorMaxIndexedDims) {
    problems.push(
      `EMBED_DIMS=${config.gemini.dims} exceeds the pgvector index limit of ` +
        `${config.pgvectorMaxIndexedDims}. Use 768, or drop the HNSW index.`
    );
  }
  if (config.chunk.overlap >= config.chunk.chars) {
    problems.push('CHUNK_OVERLAP must be smaller than CHUNK_CHARS.');
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
