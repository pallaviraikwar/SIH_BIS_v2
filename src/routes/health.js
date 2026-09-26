import express from 'express';
import { config, providerConfigured } from '../config.js';
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
      // Active providers/models. This endpoint had the same bug as the startup
      // banner: it reported `config.gemini.*`, so a fully local deployment
      // advertised Gemini models and `embedDims: undefined`.
      embedProvider: config.embedding.provider,
      embedModel: config.embedding.model,
      embedDims: config.embedding.dims,
      genProvider: config.generation.provider,
      genModel: config.generation.model,
      genFallbackProvider: config.generation.fallbackEnabled
        ? config.generation.fallbackProvider
        : null,
      topK: config.retrieval.topK,
      similarityThreshold: config.retrieval.threshold,
      softThreshold: config.retrieval.softThreshold,
      bridgeFloor: config.retrieval.bridgeFloor,
      chunkChars: config.chunk.chars,
      chunkOverlap: config.chunk.overlap,
    },
    apiKeyPresent: true,
    database: { connected: false },
    corpus: null,
    warnings: [],
  };

  if (!providerConfigured(config.generation.provider)) {
    health.warnings.push(
      `${config.generation.provider.toUpperCase()} is not configured; generation will fail.`
    );
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
