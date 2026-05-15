import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(cliRoot, '../..');
const runtimeRoot = resolve(cliRoot, 'runtime');
const packageJsonPath = resolve(cliRoot, 'package.json');
const packageJsonBackupPath = resolve(cliRoot, '.package-json.prepack-backup');

const runtimeEntries = [
  ['apps/api', 'apps/api'],
  ['apps/web', 'apps/web'],
  ['packages/collab-editor', 'packages/collab-editor'],
  ['packages/markdown', 'packages/markdown'],
  ['packages/shared', 'packages/shared'],
  ['pnpm-workspace.yaml', 'pnpm-workspace.yaml'],
  ['tsconfig.base.json', 'tsconfig.base.json'],
  ['tsconfig.json', 'tsconfig.json'],
];

async function prepareRuntime() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const packedPackageJson = {
    ...packageJson,
    dependencies: {
      ...packageJson.dependencies,
      '@marklab/collab-editor': 'file:runtime/packages/collab-editor',
      '@marklab/markdown': 'file:runtime/packages/markdown',
      '@marklab/shared': 'file:runtime/packages/shared',
    },
  };
  await writeFile(packageJsonBackupPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  await writeFile(packageJsonPath, `${JSON.stringify(packedPackageJson, null, 2)}\n`, 'utf8');

  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  for (const [source, target] of runtimeEntries) {
    await cp(resolve(repoRoot, source), resolve(runtimeRoot, target), {
      recursive: true,
      filter: (path) =>
        !path.includes('/node_modules/') &&
        !path.includes('/dist/') &&
        !path.includes('/test-results/') &&
        !path.includes('/tests/') &&
        !/\.test\.[cm]?[jt]sx?$/u.test(path),
    });
  }
  await writeFile(
    resolve(runtimeRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@marklab/cli-runtime',
        private: true,
        type: 'module',
        packageManager: 'pnpm@10.0.0',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function cleanRuntime() {
  await rm(runtimeRoot, { recursive: true, force: true });
  try {
    const backup = await readFile(packageJsonBackupPath, 'utf8');
    await writeFile(packageJsonPath, backup, 'utf8');
    await rm(packageJsonBackupPath, { force: true });
  } catch {
    // Nothing to restore.
  }
}

const command = process.argv[2] ?? 'prepare';
if (command === 'prepare') {
  await prepareRuntime();
} else if (command === 'clean') {
  await cleanRuntime();
} else {
  throw new Error(`unknown prepare-package command: ${command}`);
}
