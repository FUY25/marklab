#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const appPath = resolve(process.argv[2] ?? 'dist/MarkLab.app');
const executable = resolve(appPath, 'Contents/MacOS/MarkLabApp');
const infoPlist = resolve(appPath, 'Contents/Info.plist');
const resourceBundle = resolve(appPath, 'Contents/Resources/MarkLabMacOS_MarkLabApp.bundle');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function plistValue(key) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, infoPlist], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

if (!existsSync(appPath)) fail(`missing app bundle: ${appPath}`);
if (!existsSync(executable)) fail(`missing executable: ${executable}`);
if (!existsSync(infoPlist)) fail(`missing Info.plist: ${infoPlist}`);
if (!existsSync(resolve(resourceBundle, 'index.html'))) fail('missing bundled editor index.html');
if (!existsSync(resolve(resourceBundle, 'local-editor.js'))) fail('missing bundled editor local-editor.js');

if (plistValue('CFBundleIdentifier') !== 'com.marklab.app') fail('unexpected CFBundleIdentifier');
if (plistValue('CFBundleExecutable') !== 'MarkLabApp') fail('unexpected CFBundleExecutable');
const scheme = plistValue('CFBundleURLTypes:0:CFBundleURLSchemes:0');
if (scheme !== 'marklab') fail('marklab:// URL scheme is not registered');

const codeSign = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], {
  encoding: 'utf8',
});
if (codeSign.status !== 0) {
  fail(`codesign verification failed: ${codeSign.stderr || codeSign.stdout}`);
}

const fileType = execFileSync('file', [executable], { encoding: 'utf8' }).trim();
if (!fileType.includes('Mach-O')) fail(`unexpected executable type: ${fileType}`);

console.log(JSON.stringify({
  ok: true,
  app: appPath,
  bundleIdentifier: plistValue('CFBundleIdentifier'),
  urlScheme: scheme,
  executable,
}));
