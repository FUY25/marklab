import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('does not prepare archived app runtimes for the published package', async () => {
    const pkg = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));

    expect(pkg.files).not.toContain('runtime');
    expect(pkg.scripts ?? {}).not.toHaveProperty('prepack');
    expect(pkg.scripts ?? {}).not.toHaveProperty('postpack');
  });
});
