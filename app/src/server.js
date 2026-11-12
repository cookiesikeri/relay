'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const config = require('./config');
const { pool } = require('./db');

// ---------------------------------------------------------------- logging

let accessLog = process.stdout;
if (config.logFile) {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  accessLog = fs.createWriteStream(config.logFile, { flags: 'a' });
}

function logRequest(req, res, startedAt) {
  accessLog.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      key: req.get('Idempotency-Key') || null,
    }) + '\n',
  );
}

// ---------------------------------------------------------------- archive

let s3 = null;

async function archive(id, payload) {
  if (!config.archiveBucket) return;
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  // No explicit credentials: the SDK picks them up from the environment.
  if (!s3) s3 = new S3Client({});
  await s3.send(
    new PutObjectCommand({
      Bucket: config.archiveBucket,
      Key: `events/${id}.json`,
      Body: JSON.stringify(payload),
      ContentType: 'application/json',
    }),
  );
}

// -------------------------------------------------------------------- app

let shuttingDown = false;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  if (shuttingDown) res.set('Connection', 'close');
  const startedAt = Date.now();
  res.on('finish', () => logRequest(req, res, startedAt));
  next();
});

app.get('/livez', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health', async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ status: 'shutting down' });
  }
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('health check failed:', err.message);
    res.status(503).json({ status: 'unavailable' });
  }
});

app.post('/events', async (req, res) => {
  const key = req.get('Idempotency-Key');
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  const id = crypto.randomUUID();
  const payload = req.body;
  const signature = crypto
    .createHmac('sha256', config.signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex');

  try {
    const inserted = await pool.query(
      `INSERT INTO events (id, idempotency_key, payload, signature) VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [id, key, payload, signature],
    );
    if (inserted.rowCount === 0) {
      const existing = await pool.query('SELECT id FROM events WHERE idempotency_key = $1', [key]);
      return res.status(409).json({ id: existing.rows[0]?.id, duplicate: true });
    }
    archive(id, payload).catch((err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'archive failed', id, error: err.message }));
    });
    res.status(201).json({ id, signature });
  } catch (err) {
    console.error('failed to store event:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/events/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, idempotency_key, payload, signature, received_at FROM events WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('failed to read event:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

const server = app.listen(config.port, () => {
  console.log(`relay listening on :${config.port} (pool max ${config.poolMax})`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);
  setTimeout(() => {
    server.close(async () => {
      await pool.end().catch(() => {});
      console.log('shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  }, config.shutdownDelayMs);
  setTimeout(() => process.exit(1), config.shutdownDelayMs + 20000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
