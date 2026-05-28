#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function requireEnv(name) {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
    stdio: options.stdio ?? (options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit']),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${output ? `\n${output}` : ''}`);
  }
  return result;
}

function validateHTTPSURL(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('must use https');
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new Error(`${label} must be an HTTPS URL: ${error.message}`);
  }
}

function utcBuildNumber() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
  ].join('');
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const version = argValue('--version', optionalEnv('MARKLAB_APP_VERSION') ?? '0.1.0-alpha');
const build = argValue('--build', optionalEnv('MARKLAB_APP_BUILD') ?? utcBuildNumber());
const releaseName = `MarkLab-${version}-${build}`;
const releaseRoot = resolve(repoRoot, argValue('--release-root', 'dist/updates'));
const workDir = resolve(releaseRoot, releaseName);
const appPath = resolve(workDir, 'MarkLab.app');
const appcastDir = resolve(releaseRoot, 'appcast');
const zipPath = resolve(appcastDir, `${releaseName}.zip`);
const releaseNotesPath = resolve(appcastDir, `${releaseName}.html`);
const appcastPath = resolve(appcastDir, 'appcast.xml');
const manifestPath = resolve(workDir, 'release-manifest.json');
const skipBuild = process.argv.includes('--skip-build');
const skipAppcast = process.argv.includes('--skip-appcast');

const feedURL = validateHTTPSURL(requireEnv('MARKLAB_SPARKLE_FEED_URL'), 'MARKLAB_SPARKLE_FEED_URL');
const publicEDKey = requireEnv('MARKLAB_SPARKLE_PUBLIC_ED_KEY');
const downloadURLPrefix = validateHTTPSURL(
  requireEnv('MARKLAB_UPDATE_DOWNLOAD_URL_PREFIX'),
  'MARKLAB_UPDATE_DOWNLOAD_URL_PREFIX'
);
const productURL = optionalEnv('MARKLAB_UPDATE_PRODUCT_URL');
const privateEDKey = optionalEnv('MARKLAB_SPARKLE_PRIVATE_ED_KEY');
const privateEDKeyFile = optionalEnv('MARKLAB_SPARKLE_ED_KEY_FILE');
if (privateEDKey && privateEDKeyFile) {
  throw new Error('Set only one of MARKLAB_SPARKLE_PRIVATE_ED_KEY or MARKLAB_SPARKLE_ED_KEY_FILE');
}
if (!skipAppcast && !privateEDKey && !privateEDKeyFile) {
  throw new Error('Signed appcast generation requires MARKLAB_SPARKLE_PRIVATE_ED_KEY or MARKLAB_SPARKLE_ED_KEY_FILE. Use --skip-appcast only for local packaging dry-runs.');
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(appcastDir, { recursive: true });

run('node', [
  resolve(packageRoot, 'scripts/package-app.mjs'),
  '--output',
  appPath,
  ...(skipBuild ? ['--skip-build'] : []),
], {
  cwd: packageRoot,
  env: {
    MARKLAB_APP_VERSION: version,
    MARKLAB_APP_BUILD: build,
    MARKLAB_SPARKLE_FEED_URL: feedURL,
    MARKLAB_SPARKLE_PUBLIC_ED_KEY: publicEDKey,
  },
});

rmSync(zipPath, { force: true });
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]);

writeFileSync(releaseNotesPath, `<!doctype html>
<html>
<head><meta charset="utf-8"><title>MarkLab ${xmlEscape(version)}</title></head>
<body>
  <h1>MarkLab ${xmlEscape(version)}</h1>
  <p>Build ${xmlEscape(build)}</p>
</body>
</html>
`);

const generateAppcast = resolve(packageRoot, '.build/artifacts/sparkle/Sparkle/bin/generate_appcast');
let appcastGenerated = false;
if (!skipAppcast) {
  if (!existsSync(generateAppcast)) {
    throw new Error(`missing Sparkle generate_appcast tool: ${generateAppcast}`);
  }
  const args = [
    '--download-url-prefix',
    downloadURLPrefix,
    '--embed-release-notes',
    '-o',
    appcastPath,
  ];
  if (productURL) args.push('--link', validateHTTPSURL(productURL, 'MARKLAB_UPDATE_PRODUCT_URL'));
  if (privateEDKey) args.push('--ed-key-file', '-');
  if (privateEDKeyFile) args.push('--ed-key-file', privateEDKeyFile);
  args.push(appcastDir);
  run(generateAppcast, args, {
    input: privateEDKey ? `${privateEDKey}\n` : undefined,
  });
  appcastGenerated = true;
}

const manifest = {
  ok: true,
  app: appPath,
  archive: zipPath,
  releaseNotes: releaseNotesPath,
  appcast: appcastPath,
  appcastGenerated,
  feedURL,
  downloadURLPrefix,
  version,
  build,
  sha256: sha256(zipPath),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(manifestPath, resolve(appcastDir, `${releaseName}.json`));
console.log(JSON.stringify(manifest));
