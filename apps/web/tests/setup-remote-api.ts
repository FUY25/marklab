import { readFile } from 'node:fs/promises';
import pg from 'pg';

const localHostnames = new Set(['localhost', '127.0.0.1', '::1']);
const remoteApiResetLockNamespace = 1296847170;
const remoteApiResetLockKey = 1380275796;

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

export function requireLocalWebsocketUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`${label} must use ws or wss`);
  }

  const hostname = normalizeHostname(url.hostname);
  if (!localHostnames.has(hostname)) {
    throw new Error(`${label} must point to localhost, 127.0.0.1, or ::1`);
  }

  return url;
}

export function rejectManagedUrlOverrides() {
  if (process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true') return;

  const blockedOverrides = ['MARKLAB_E2E_WEB_URL', 'MARKLAB_E2E_API_URL', 'MARKLAB_E2E_WS_URL'].filter(
    (name) => process.env[name],
  );
  if (blockedOverrides.length > 0) {
    throw new Error(
      `${blockedOverrides.join(', ')} ${blockedOverrides.length === 1 ? 'is' : 'are'} only allowed when MARKLAB_E2E_ALLOW_EXISTING_API=true`,
    );
  }
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
  rejectManagedUrlOverrides();

  if (process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true') {
    const apiUrl = process.env.MARKLAB_E2E_API_URL ?? 'http://127.0.0.1:3011';
    const websocketUrl = process.env.MARKLAB_E2E_WS_URL;
    requireLocalHttpUrl(apiUrl, 'MARKLAB_E2E_API_URL');
    if (websocketUrl) requireLocalWebsocketUrl(websocketUrl, 'MARKLAB_E2E_WS_URL');
    return;
  }

  const client = new pg.Client({ connectionString: requireTestDatabaseUrl() });
  await client.connect();

  let locked = false;
  let resetError: unknown;
  try {
    await client.query('select pg_advisory_lock($1::integer, $2::integer)', [
      remoteApiResetLockNamespace,
      remoteApiResetLockKey,
    ]);
    locked = true;
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    const schema = await readFile(new URL('../../api/src/db/schema.sql', import.meta.url), 'utf8');
    await client.query(schema);
  } catch (error) {
    resetError = error;
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query('select pg_advisory_unlock($1::integer, $2::integer)', [
          remoteApiResetLockNamespace,
          remoteApiResetLockKey,
        ]);
      } catch (error) {
        if (!resetError) throw error;
      }
    }
    await client.end();
  }
}

export default setupRemoteApi;
