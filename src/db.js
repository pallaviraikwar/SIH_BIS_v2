import fs from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// A single pool for the whole process. max is deliberately small: this is a
// single-user demo and each request only needs one connection.
export const pool = new Pool({
  connectionString: config.db.connectionString,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // A pooled client can die while idle (e.g. container restart). Log and let the
  // pool replace it instead of crashing the process.
  console.error('[db] idle client error:', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function migrate() {
  const sql = await fs.readFile(config.corpus.schemaPath, 'utf8');
  await pool.query(sql);
}

/**
 * pgvector expects a bare array literal like '[0.1,0.2,...]'. The pg driver
 * would otherwise try to parse a JS array into a Postgres array literal, which
 * loses precision and adds whitespace, so format it explicitly.
 */
export function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}

export async function closePool() {
  await pool.end();
}
