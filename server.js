import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfig } from './src/config.js';
import { migrate, closePool } from './src/db.js';
import { chatRouter } from './src/routes/chat.js';
import { searchRouter } from './src/routes/search.js';
import { healthRouter } from './src/routes/health.js';
import { documentsRouter } from './src/routes/documents.js';

const app = express();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(ROOT, 'BIS_Assistant_frontend.html');

app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.use('/api', chatRouter);
app.use('/api', searchRouter);
app.use('/api', healthRouter);
app.use('/api', documentsRouter);

// Serve the chat UI from the same origin as the API, so one `npm start` runs the
// whole app. Registered before the 404 handler below, which would otherwise
// swallow every non-/api request.
app.get('/', (_req, res) => res.sendFile(UI_FILE));

app.use((req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
});

// Express 5 forwards rejected promises from async handlers here, so a throw
// inside a route produces a real 500 rather than a hung request.
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    assertConfig();
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  }

  try {
    await migrate();
    console.log('[db] schema ready (pgvector extension + tables present)');
  } catch (err) {
    console.error(`\n✗ Could not connect to Postgres at ${config.db.connectionString.replace(/:[^:@/]*@/, ':***@')}`);
    console.error(`  ${err.message}`);
    console.error('  Start the vector store with:  docker compose up -d\n');
    // Deliberately non-fatal: /api/health reports the failure precisely, and
    // keeping the process up means /api/health is still reachable to show it.
  }

  const server = app.listen(config.port, () => {
    console.log(`\n✅ BIS RAG server on http://localhost:${config.port}`);
    console.log(`   UI      http://localhost:${config.port}/`);
    console.log(`   embed   ${config.gemini.embedModel} @ ${config.gemini.dims} dims`);
    console.log(`   gen     ${config.gemini.genModel}`);
    console.log(`   topK    ${config.retrieval.topK} @ threshold ${config.retrieval.threshold}`);
    console.log(`   corpus  ${config.corpus.pdfDir}\n`);
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close();
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
