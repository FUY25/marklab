#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const appIcon = resolve(packageRoot, 'Assets/MarkLabIcon.icns');
if (!existsSync(executable)) throw new Error(`missing built executable: ${executable}`);
if (!existsSync(resourceBundle)) throw new Error(`missing built resource bundle: ${resourceBundle}`);
if (!existsSync(appIcon)) throw new Error(`missing app icon: ${appIcon}`);

rmSync(output, { recursive: true, force: true });
mkdirSync(resolve(output, 'Contents/MacOS'), { recursive: true });
mkdirSync(resolve(output, 'Contents/Resources'), { recursive: true });
cpSync(executable, resolve(output, 'Contents/MacOS/MarkLabApp'));
cpSync(resourceBundle, resolve(output, 'Contents/Resources/MarkLabMacOS_MarkLabApp.bundle'), { recursive: true });
cpSync(appIcon, resolve(output, 'Contents/Resources/MarkLab.icns'));

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
  icon: resolve(output, 'Contents/Resources/MarkLab.icns'),
  codeSignaturePresent: sign,
  signingMode: sign ? 'ad-hoc' : 'none',
  signingIdentity: sign ? '-' : null,
  developerIdSigned: false,
  notarized: false,
  distributionReady: false,
}));
