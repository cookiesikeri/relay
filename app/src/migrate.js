'use strict';

const { Client } = require('pg');
const config = require('./config');

const migrations = [
  {
    version: 1,
    name: 'create events',
    sql: `
      CREATE TABLE events (
        id              uuid PRIMARY KEY,
        idempotency_key text NOT NULL,
        payload         jsonb NOT NULL,
        received_at     timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    version: 2,
    name: 'add signature and backfill',
    // The backfill takes a few seconds against production-sized data.
    // pg_sleep stands in for that here so local runs behave the same way.
    sql: `
      SELECT pg_sleep(2);
      ALTER TABLE events ADD COLUMN signature text;
      UPDATE events SET signature = '' WHERE signature IS NULL`,
  },
  {
    version: 3,
    name: 'unique idempotency key',
    sql: `CREATE UNIQUE INDEX events_idempotency_key ON events (idempotency_key)`,
  },
];

const LOCK_ID = 7426001;

async function connectWithRetry(attempts = 30) {
  for (let i = 1; ; i++) {
    const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (i >= attempts) throw err;
      console.log(`migrate: database not reachable (${err.message}), retry ${i}/${attempts}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const client = await connectWithRetry();
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await client.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    console.log(`migrate: applying ${m.version} (${m.name})`);
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  console.log('migrate: up to date');
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
  await client.end();
}

main().catch((err) => {
  console.error('migrate: failed:', err.message);
  process.exit(1);
});
