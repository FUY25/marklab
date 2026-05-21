import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), 'utf8');
}

function parseApiComposeEnvironment(compose: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = compose.split(/\r?\n/u);
  let inApi = false;
  let inEnvironment = false;
  for (const line of lines) {
    if (/^  [a-zA-Z0-9_-]+:/u.test(line)) {
      inApi = line.trim() === 'api:';
      inEnvironment = false;
      continue;
    }
    if (!inApi) continue;
    if (/^    environment:/u.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (!inEnvironment) continue;
    if (line.trim().startsWith('#')) continue;
    const match = /^      ([A-Z0-9_]+):\s*(.*)$/u.exec(line);
    if (!match) {
      if (line.trim()) break;
      continue;
    }
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined) env[key] = value.replace(/^"(.*)"$/u, '$1');
  }
  return env;
}

describe('production deploy config', () => {
  it('does not build or serve the archived apps/web surface in production', async () => {
    const [dockerfile, flyToml, flyExample, prodSmokeCompose] = await Promise.all([
      readRepoFile('infra/docker/api.Dockerfile'),
      readRepoFile('fly.toml'),
      readRepoFile('infra/fly/fly.toml.example'),
      readRepoFile('infra/docker/docker-compose.prod-smoke.yml'),
    ]);

    for (const source of [dockerfile, flyToml, flyExample, prodSmokeCompose]) {
      expect(source).not.toContain('MARKLAB_WEB_DIST_DIR');
    }

    for (const source of [flyToml, flyExample, prodSmokeCompose]) {
      expect(source).not.toContain('MARKLAB_PUBLIC_RELAY_WS_URL');
      expect(source).not.toContain('MARKLAB_ENABLE_RELAY');
      expect(source).not.toMatch(/MARKLAB_RELAY_(?:EPHEMERAL|HOST|MAX)_/u);
    }

    expect(dockerfile).not.toContain('apps/web');
    expect(dockerfile).not.toContain('@marklab/web');
    expect(prodSmokeCompose).not.toContain('infra/docker/web.Dockerfile');
    expect(prodSmokeCompose).not.toMatch(/\n\s+web:\n/u);
  });

  it('keeps the new collab-web surface in the production API image', async () => {
    const dockerfile = await readRepoFile('infra/docker/api.Dockerfile');

    expect(dockerfile).toContain('apps/collab-web');
    expect(dockerfile).toContain('@marklab/collab-web build');
    expect(dockerfile).toContain('MARKLAB_COLLAB_WEB_DIST_DIR');
  });

  it('keeps the local production smoke compose env loadable by the API', async () => {
    const prodSmokeCompose = await readRepoFile('infra/docker/docker-compose.prod-smoke.yml');
    const env = loadApiEnv(parseApiComposeEnvironment(prodSmokeCompose));

    expect(env).toMatchObject({
      mode: 'production',
      publicWebUrl: 'http://127.0.0.1:3001',
      publicApiUrl: 'http://127.0.0.1:3001',
      ysweetProviderMode: 'process',
      ysweetPublicUrlPrefix: 'http://127.0.0.1:3001',
      ysweetStorePath: '/data/ysweet',
    });
  });
});
