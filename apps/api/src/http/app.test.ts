import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DbPool } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { createHttpApp } from './app';

function createLocalOnlyPool(): DbPool {
  async function unavailable(): Promise<never> {
    throw new Error('database_not_configured');
  }

  return {
    query: unavailable,
    connect: unavailable,
  };
}

function createSchemaPool(input: {
  tables: readonly string[];
  columns?: Record<string, readonly string[]>;
}): DbPool {
  const tables = new Set(input.tables);
  const columns = input.columns ?? {};

  async function query<Row = unknown>(sql: string, params?: readonly unknown[]) {
    if (sql === 'select 1') return { rows: [{} as Row], rowCount: 1 };
    if (sql.includes('information_schema.tables')) {
      const requested = params?.[0] as readonly string[];
      return {
        rows: requested.filter((table) => tables.has(table)).map((table_name) => ({ table_name }) as Row),
        rowCount: requested.length,
      };
    }
    if (sql.includes('information_schema.columns')) {
      const requestedTables = params?.[0] as readonly string[];
      const requestedColumns = new Set(params?.[1] as readonly string[]);
      const rows = requestedTables.flatMap((table_name) => (
        (columns[table_name] ?? [])
          .filter((column_name) => requestedColumns.has(column_name))
          .map((column_name) => ({ table_name, column_name }) as Row)
      ));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected_query:${sql}`);
  }

  return {
    query,
    async connect() {
      return {
        query,
        release: () => undefined,
      };
    },
  };
}

async function createWebDist() {
  const distDir = await mkdtemp(join(tmpdir(), 'marklab-web-dist-'));
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">MarkLab</div>', 'utf8');
  await writeFile(join(distDir, 'asset.txt'), 'asset', 'utf8');
  return distDir;
}

describe('http app hosted web serving', () => {
  it('serves built web assets and falls hosted relay routes back to index.html', async () => {
    const distDir = await createWebDist();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      staticWeb: { distDir },
    });

    await expect(request(app).get('/asset.txt').expect(200)).resolves.toMatchObject({ text: 'asset' });
    await expect(request(app).get('/relay/room_1?token=secret').expect(200)).resolves.toMatchObject({
      text: expect.stringContaining('MarkLab'),
    });
  });

  it('does not let the single-page app fallback shadow API routes or health', async () => {
    const distDir = await createWebDist();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      staticWeb: { distDir },
    });

    await request(app).get('/healthz').expect(200);
    await request(app).get('/api/not-a-real-route').expect(404);
  });

  it('mounts provider document proxy routes before the single-page app fallback', async () => {
    const distDir = await createWebDist();
    const proxied: string[] = [];
    const providerHttpProxy: RequestHandler = (req, res, next) => {
      if (!req.url.startsWith('/d/')) {
        next();
        return;
      }
      proxied.push(req.url);
      res.status(203).send('proxied');
    };
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      providerHttpProxy,
      staticWeb: { distDir },
    });

    await expect(request(app).get('/d/doc_1/as-update?z=cache').expect(203)).resolves.toMatchObject({
      text: 'proxied',
    });
    expect(proxied).toEqual(['/d/doc_1/as-update?z=cache']);
    await expect(request(app).get('/not-provider-route').expect(200)).resolves.toMatchObject({
      text: expect.stringContaining('MarkLab'),
    });
  });
});

describe('http app readiness', () => {
  it('can report relay readiness for a remote hosted relay adapter without a local relay websocket server', async () => {
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      health: {
        relayRequired: true,
        relayReady: true,
      },
    });

    await request(app)
      .get('/healthz')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          ok: true,
          relay: {
            required: true,
            ready: true,
            connectionCount: 0,
          },
        });
      });
  });

  it('returns 503 when a required provider is down', async () => {
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      health: {
        providerRequired: true,
        providerHealth: async () => ({
          mode: 'process',
          ready: false,
          storeReady: false,
          serverUrl: 'http://127.0.0.1:8080',
          error: 'provider_ready_failed:503',
        }),
      },
    });

    await request(app)
      .get('/healthz')
      .expect(503)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          ok: false,
          provider: {
            required: true,
            ready: false,
            storeReady: false,
            mode: 'process',
            serverUrl: 'http://127.0.0.1:8080',
            error: 'provider_ready_failed:503',
          },
        });
      });
  });

  it('returns 503 when provider schema tables or columns are missing', async () => {
    const app = createHttpApp(
      createSchemaPool({
        tables: ['relay_rooms', 'relay_access_grants', 'relay_access_sessions', 'document_branch_states', 'collab_sessions'],
        columns: {
          document_branch_states: ['provider_doc_id'],
        },
      }),
      createUnavailableLiveMarkdownWriter(),
      {
        health: {
          databaseRequired: true,
          providerRequired: true,
          providerHealth: async () => ({
            mode: 'process',
            ready: true,
            storeReady: true,
            serverUrl: 'http://127.0.0.1:8080',
            error: null,
          }),
          schemaTables: ['relay_rooms', 'relay_access_grants', 'relay_access_sessions', 'document_branch_states', 'collab_sessions', 'provider_token_issuances'],
          schemaColumns: {
            document_branch_states: ['provider_doc_id', 'provider_doc_seeded_at'],
          },
        },
      },
    );

    await request(app)
      .get('/healthz')
      .expect(503)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          ok: false,
          schema: {
            required: true,
            ready: false,
            missing: ['provider_token_issuances', 'document_branch_states.provider_doc_seeded_at'],
          },
        });
      });
  });

  it('does not fail readiness when an optional provider health probe is down', async () => {
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      health: {
        providerRequired: false,
        providerHealth: async () => ({
          mode: 'external',
          ready: false,
          storeReady: false,
          serverUrl: 'https://ysweet.example.com',
          error: 'provider_ready_failed:503',
        }),
      },
    });

    await request(app)
      .get('/healthz')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          ok: true,
          provider: {
            required: false,
            ready: false,
            storeReady: false,
            mode: 'external',
            serverUrl: 'https://ysweet.example.com',
            error: 'provider_ready_failed:503',
          },
        });
      });
  });

  it('returns 200 when a required provider is ready', async () => {
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      health: {
        providerRequired: true,
        providerHealth: async () => ({
          mode: 'process',
          ready: true,
          storeReady: true,
          serverUrl: 'http://127.0.0.1:8080',
          error: null,
        }),
      },
    });

    await request(app)
      .get('/healthz')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          ok: true,
          provider: {
            required: true,
            ready: true,
            storeReady: true,
            mode: 'process',
            serverUrl: 'http://127.0.0.1:8080',
            error: null,
          },
        });
      });
  });
});
