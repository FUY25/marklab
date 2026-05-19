import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLegacyCliRuntimeAvailable } from './marklab.mjs';

const cliRoot = dirname(fileURLToPath(import.meta.url));

describe('@marklab/cli package metadata', () => {
  it('does not publish archived editor/relay runtime dependencies for the default CLI path', async () => {
    const pkg = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
    const dependencyNames = Object.keys(pkg.dependencies ?? {});
    const archivedRuntimeDependencies = dependencyNames.filter((name) => (
      name.startsWith('@hocuspocus/')
      || name.startsWith('@milkdown/')
      || name === 'y-prosemirror'
    ));

    expect(archivedRuntimeDependencies).toEqual([]);
  });

  it('blocks archived daemon commands from the packaged runtime', () => {
    expect(() => assertLegacyCliRuntimeAvailable(
      { command: 'create-link', file: 'README.md' },
      { MARKLAB_ENABLE_LEGACY_CLI: '1' },
      '/tmp/marklab-package/runtime',
    )).toThrow(/packaged @marklab\/cli no longer bundles/i);
  });

  it('does not prepare archived app runtimes for the published package', async () => {
    const prepareSource = await readFile(join(cliRoot, 'prepare-package.mjs'), 'utf8');

    expect(prepareSource).not.toContain("'apps/web'");
    expect(prepareSource).not.toContain("'apps/api'");
  });
});
