import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
});
