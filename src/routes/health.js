import express from 'express';
import { config } from '../config.js';
import { getCorpusStats } from '../store.js';

export const healthRouter = express.Router();

/**
 * Reports whether the whole stack is actually usable: DB reachable, schema
 * present, corpus ingested. A server that boots but has an empty vector store
 * answers every question with "not found", which is the most confusing possible
 * demo failure — this endpoint makes that state obvious.
 */
healthRouter.get('/health', async (_req, res) => {
  const health = {
    status: 'ok',
    config: {
      embedModel: config.gemini.embedModel,
      genModel: config.gemini.genModel,
      embedDims: config.gemini.dims,
      topK: config.retrieval.topK,
      similarityThreshold: config.retrieval.threshold,
      chunkChars: config.chunk.chars,
      chunkOverlap: config.chunk.overlap,
    },
    apiKeyPresent: Boolean(config.gemini.apiKey),
    database: { connected: false },
    corpus: null,
    warnings: [],
  };

  if (!health.apiKeyPresent) {
    health.warnings.push('GEMINI_API_KEY is not set; every request will fail.');
  }

  try {
    const stats = await getCorpusStats();
    health.database.connected = true;
    health.corpus = { chunkCount: stats.chunkCount, docCount: stats.docCount, documents: stats.documents };

    if (stats.chunkCount === 0) {
      health.status = 'degraded';
      health.warnings.push(
        `No chunks ingested. Put BIS PDFs in ${config.corpus.pdfDir} and run: npm run ingest`
      );
    }

    const scanned = stats.documents.filter((d) => d.isScanned);
    if (scanned.length) {
      health.warnings.push(
        `${scanned.length} document(s) look like scans with no text layer and will retrieve poorly: ` +
          scanned.map((d) => d.docTitle).join(', ')
      );
    }
  } catch (err) {
    health.status = 'degraded';
    health.database.error = err.message;
    health.warnings.push(
      `Cannot reach the vector store at ${config.db.connectionString.replace(/:[^:@/]*@/, ':***@')}. ` +
        'Start it with: docker compose up -d'
    );
  }

  return res.status(health.status === 'ok' ? 200 : 503).json(health);
});
