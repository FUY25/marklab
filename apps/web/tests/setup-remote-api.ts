import { readFile } from 'node:fs/promises';
import pg from 'pg';

const localHostnames = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/u, '').replace(/\]$/u, '');
}

export function requireLocalHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }

  const hostname = normalizeHostname(url.hostname);
  if (!localHostnames.has(hostname)) {
    throw new Error(`${label} must point to localhost, 127.0.0.1, or ::1`);
  }

  return url;
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for remote document browser tests');

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid URL');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!localHostnames.has(hostname)) {
    throw new Error('Refusing to reset database because TEST_DATABASE_URL host is not local');
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL database name must be valid URL encoding');
  }

  if (!databaseName || !/(?:_test|test_)/u.test(databaseName)) {
    throw new Error('Refusing to reset database because TEST_DATABASE_URL database name is not marked as test');
  }

  return databaseUrl;
}

export async function setupRemoteApi() {
  if (process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true') {
    const apiUrl = process.env.MARKLAB_E2E_API_URL ?? 'http://127.0.0.1:3011';
    requireLocalHttpUrl(apiUrl, 'MARKLAB_E2E_API_URL');
    return;
  }

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

export default setupRemoteApi;
