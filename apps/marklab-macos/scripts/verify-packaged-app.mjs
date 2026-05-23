#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const appPath = resolve(process.argv[2] ?? 'dist/MarkLab.app');
const executable = resolve(appPath, 'Contents/MacOS/MarkLabApp');
const infoPlist = resolve(appPath, 'Contents/Info.plist');
const resourceBundle = resolve(appPath, 'Contents/Resources/MarkLabMacOS_MarkLabApp.bundle');
const appIcon = resolve(appPath, 'Contents/Resources/MarkLab.icns');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function detailValue(output, key) {
  const match = output.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function plistValue(key) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, infoPlist], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function signingModeFor(signature) {
  if (signature === 'adhoc') return 'ad-hoc';
  if (signature) return 'certificate';
  return 'unknown';
}

if (!existsSync(appPath)) fail(`missing app bundle: ${appPath}`);
if (!existsSync(executable)) fail(`missing executable: ${executable}`);
if (!existsSync(infoPlist)) fail(`missing Info.plist: ${infoPlist}`);
if (!existsSync(appIcon)) fail(`missing app icon: ${appIcon}`);
if (!existsSync(resolve(resourceBundle, 'index.html'))) fail('missing bundled editor index.html');
if (!existsSync(resolve(resourceBundle, 'local-editor.js'))) fail('missing bundled editor local-editor.js');

if (plistValue('CFBundleIdentifier') !== 'com.marklab.app') fail('unexpected CFBundleIdentifier');
if (plistValue('CFBundleExecutable') !== 'MarkLabApp') fail('unexpected CFBundleExecutable');
if (plistValue('CFBundleIconFile') !== 'MarkLab') fail('unexpected CFBundleIconFile');
const scheme = plistValue('CFBundleURLTypes:0:CFBundleURLSchemes:0');
if (scheme !== 'marklab') fail('marklab:// URL scheme is not registered');

const codeSign = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], {
  encoding: 'utf8',
});
if (codeSign.status !== 0) {
  fail(`codesign verification failed: ${codeSign.stderr || codeSign.stdout}`);
}

const codeSignDetails = spawnSync('codesign', ['-dv', '--verbose=4', appPath], {
  encoding: 'utf8',
});
const codeSignDetailOutput = combinedOutput(codeSignDetails);
const signature = detailValue(codeSignDetailOutput, 'Signature');
const teamIdentifier = detailValue(codeSignDetailOutput, 'TeamIdentifier');
const developerIdSigned = /Authority=Developer ID Application:/m.test(codeSignDetailOutput);

const gatekeeper = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], {
  encoding: 'utf8',
});
const gatekeeperStatus = combinedOutput(gatekeeper);

const stapler = spawnSync('xcrun', ['stapler', 'validate', appPath], {
  encoding: 'utf8',
});
const staplerStatus = combinedOutput(stapler);
const notarized = stapler.status === 0;
const distributionReady = developerIdSigned && gatekeeper.status === 0 && notarized;

const fileType = execFileSync('file', [executable], { encoding: 'utf8' }).trim();
if (!fileType.includes('Mach-O')) fail(`unexpected executable type: ${fileType}`);
const iconType = execFileSync('file', [appIcon], { encoding: 'utf8' }).trim();
if (!iconType.includes('Mac OS X icon')) fail(`unexpected app icon type: ${iconType}`);

console.log(JSON.stringify({
  ok: true,
  app: appPath,
  bundleIdentifier: plistValue('CFBundleIdentifier'),
  urlScheme: scheme,
  executable,
  icon: appIcon,
  codeSignaturePresent: true,
  signingMode: signingModeFor(signature),
  signature,
  teamIdentifier,
  developerIdSigned,
  gatekeeperAccepted: gatekeeper.status === 0,
  gatekeeperStatus,
  notarized,
  notarizationStatus: staplerStatus,
  distributionReady,
}));
