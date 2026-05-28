#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
  return result;
}

function findDirectory(root, predicate) {
  if (!existsSync(root)) return null;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory() && predicate(path, entry.name)) return path;
  }
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      const found = findDirectory(path, predicate);
      if (found) return found;
    }
  }
  return null;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function validateHTTPSURL(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('must use https');
  } catch (error) {
    throw new Error(`${label} must be an HTTPS URL: ${error.message}`);
  }
}

function plistEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const configuration = argValue('--configuration', 'release');
const output = resolve(repoRoot, argValue('--output', 'dist/MarkLab.app'));
const skipBuild = process.argv.includes('--skip-build');
const skipEditorBuild = process.argv.includes('--skip-editor-build');
const sign = !process.argv.includes('--no-sign');
const sparkleFeedURL = optionalEnv('MARKLAB_SPARKLE_FEED_URL');
const sparklePublicEDKey = optionalEnv('MARKLAB_SPARKLE_PUBLIC_ED_KEY');
if (Boolean(sparkleFeedURL) !== Boolean(sparklePublicEDKey)) {
  throw new Error('MARKLAB_SPARKLE_FEED_URL and MARKLAB_SPARKLE_PUBLIC_ED_KEY must be set together');
}
if (sparkleFeedURL) validateHTTPSURL(sparkleFeedURL, 'MARKLAB_SPARKLE_FEED_URL');

if (!skipBuild) {
  if (!skipEditorBuild) {
    run('npx', ['-y', 'pnpm@10.0.0', '--dir', packageRoot, 'build:local-editor'], { cwd: repoRoot });
  }
  run('swift', ['build', '--configuration', configuration], { cwd: packageRoot });
}

const binPath = execFileSync('swift', ['build', '--configuration', configuration, '--show-bin-path'], {
  cwd: packageRoot,
  encoding: 'utf8',
}).trim();
const executable = resolve(binPath, 'MarkLabApp');
const resourceBundle = resolve(binPath, 'MarkLabMacOS_MarkLabApp.bundle');
const sparkleFramework = findDirectory(
  resolve(packageRoot, '.build/artifacts/sparkle/Sparkle/Sparkle.xcframework'),
  (_path, name) => name === 'Sparkle.framework'
) ?? resolve(binPath, 'Sparkle.framework');
const appIcon = resolve(packageRoot, 'Assets/MarkLabIcon.icns');
if (!existsSync(executable)) throw new Error(`missing built executable: ${executable}`);
if (!existsSync(resourceBundle)) throw new Error(`missing built resource bundle: ${resourceBundle}`);
if (!existsSync(sparkleFramework)) throw new Error(`missing Sparkle.framework: ${sparkleFramework}`);
if (!existsSync(appIcon)) throw new Error(`missing app icon: ${appIcon}`);
if (!statSync(sparkleFramework).isDirectory()) throw new Error(`Sparkle.framework is not a directory: ${sparkleFramework}`);

rmSync(output, { recursive: true, force: true });
mkdirSync(resolve(output, 'Contents/MacOS'), { recursive: true });
mkdirSync(resolve(output, 'Contents/Resources'), { recursive: true });
mkdirSync(resolve(output, 'Contents/Frameworks'), { recursive: true });
cpSync(executable, resolve(output, 'Contents/MacOS/MarkLabApp'));
cpSync(resourceBundle, resolve(output, 'Contents/Resources/MarkLabMacOS_MarkLabApp.bundle'), { recursive: true });
cpSync(sparkleFramework, resolve(output, 'Contents/Frameworks/Sparkle.framework'), {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(appIcon, resolve(output, 'Contents/Resources/MarkLab.icns'));

const sparklePlist = sparkleFeedURL ? `  <key>SUFeedURL</key>
  <string>${plistEscape(sparkleFeedURL)}</string>
  <key>SUPublicEDKey</key>
  <string>${plistEscape(sparklePublicEDKey)}</string>
` : '';

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>MarkLabApp</string>
  <key>CFBundleIdentifier</key>
  <string>com.marklab.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>MarkLab</string>
  <key>CFBundleDisplayName</key>
  <string>MarkLab</string>
  <key>CFBundleIconFile</key>
  <string>MarkLab</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${plistEscape(process.env.MARKLAB_APP_VERSION ?? '0.0.0-alpha')}</string>
  <key>CFBundleVersion</key>
  <string>${plistEscape(process.env.MARKLAB_APP_BUILD ?? '1')}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
${sparklePlist}  <key>SUEnableInstallerLauncherService</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>MarkLab Shared Document</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>marklab</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
writeFileSync(resolve(output, 'Contents/Info.plist'), infoPlist);

if (sign) {
  run('codesign', ['--force', '--deep', '--sign', '-', output], { cwd: repoRoot });
}

console.log(JSON.stringify({
  ok: true,
  app: output,
  executable: resolve(output, 'Contents/MacOS/MarkLabApp'),
  resourceBundle: resolve(output, 'Contents/Resources/MarkLabMacOS_MarkLabApp.bundle'),
  sparkleFramework: resolve(output, 'Contents/Frameworks/Sparkle.framework'),
  icon: resolve(output, 'Contents/Resources/MarkLab.icns'),
  sparkleUpdatesConfigured: Boolean(sparkleFeedURL),
  sparkleFeedURL,
  codeSignaturePresent: sign,
  signingMode: sign ? 'ad-hoc' : 'none',
  signingIdentity: sign ? '-' : null,
  developerIdSigned: false,
  notarized: false,
  distributionReady: false,
}));
