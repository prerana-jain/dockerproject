'use strict';

const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DB config from env ──────────────────────────────────────────────────────
const dbConfig = {
  host:     process.env.DB_HOST     || 'db',
  port:     parseInt(process.env.DB_PORT || '3306', 10),
  user:     process.env.DB_USER     || 'app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'appdb',
  connectTimeout: 10000,
};

// ── Connection pool (created lazily after DB is ready) ──────────────────────
let pool = null;

async function createPool() {
  pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
  });
  // Verify one connection works
  const conn = await pool.getConnection();
  conn.release();
  return pool;
}

// ── Retry logic ─────────────────────────────────────────────────────────────
const RETRY_INTERVAL_MS = 5000;
const MAX_RETRIES        = 20;          // ~100 s total wait

async function connectWithRetry(attempt = 1) {
  try {
    console.log(`[DB] Connection attempt ${attempt}/${MAX_RETRIES} …`);
    await createPool();
    console.log('[DB] Connected successfully.');
  } catch (err) {
    console.error(`[DB] Attempt ${attempt} failed: ${err.message}`);
    if (attempt >= MAX_RETRIES) {
      console.error('[DB] Max retries reached. The app will keep running; /health will report DB down.');
      return;
    }
    await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
    return connectWithRetry(attempt + 1);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.send('OK');
});

app.get('/health', async (_req, res) => {
  const health = {
    status:    'ok',
    timestamp: new Date().toISOString(),
    service:   'backend',
    database:  { status: 'unknown', message: '' },
  };

  try {
    if (!pool) throw new Error('Pool not initialised');
    const [rows] = await pool.query('SELECT 1 AS result');
    if (rows[0].result === 1) {
      health.database.status  = 'ok';
      health.database.message = 'MySQL reachable';
    }
  } catch (err) {
    health.status             = 'degraded';
    health.database.status    = 'error';
    health.database.message   = err.message;

    // Attempt to re-establish pool silently
    if (!pool) connectWithRetry().catch(() => {});
  }

  const httpStatus = health.status === 'ok' ? 200 : 503;
  res.status(httpStatus).json(health);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[APP] Received ${signal}. Shutting down gracefully…`);
  if (pool) await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ────────────────────────────────────────────────────────────────────
(async () => {
  // Start HTTP server immediately so healthchecks can hit it
  app.listen(PORT, () => {
    console.log(`[APP] Listening on port ${PORT}`);
  });

  // Connect to DB in background with retry
  await connectWithRetry();
})();
