import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), 'utf8');
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
});
