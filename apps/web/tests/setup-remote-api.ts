import { readFile } from 'node:fs/promises';
import pg from 'pg';

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for remote document browser tests');

  const safeTarget =
    databaseUrl.includes('_test') || databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  if (!safeTarget) {
    throw new Error('Refusing to reset database because TEST_DATABASE_URL does not look like a test database');
  }

  return databaseUrl;
}

export default async function setupRemoteApi() {
  if (process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true') return;

  const client = new pg.Client({ connectionString: requireTestDatabaseUrl() });
  await client.connect();

  try {
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    const schema = await readFile(new URL('../../api/src/db/schema.sql', import.meta.url), 'utf8');
    await client.query(schema);
  } finally {
    await client.end();
  }
}
