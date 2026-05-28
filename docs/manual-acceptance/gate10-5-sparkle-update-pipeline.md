# Gate 10.5 Sparkle Update Pipeline Evidence

Date: 2026-05-28

Status: paused after plumbing. Sparkle/appcast code support is implemented, but update signing and live appcast publishing are intentionally not active yet.

Product decision:

- Use the bounded-beta path for now: ad-hoc signed app builds plus a scoped Gatekeeper workaround remain acceptable for named pilot users.
- Do not generate or commit a Sparkle private signing key yet.
- Do not put any Sparkle private key in the repo. The public EdDSA key can be recorded once generated because it is embedded in the app for verification, but the private key is release authority and must live in a controlled keychain, CI secret, or secret manager.
- A GitHub Pages update host can be connected first as a public-but-unlisted feed location, but the app must not advertise auto-update as working until the real signed appcast smoke passes.

Candidate update host:

- Feed URL: `https://fuy25.github.io/marklab-updates/appcast.xml`
- Download URL prefix: `https://fuy25.github.io/marklab-updates`

This host is suitable for bounded beta if the update artifacts being public-but-unlisted is acceptable. It is not a private distribution channel.

## Implemented

- Added Sparkle 2.9.2 to the SwiftPM package.
- Added an optional `Check for Updates...` app menu command. It is only created when the packaged app has both:
  - `SUFeedURL`
  - `SUPublicEDKey`
- Updated `package-app.mjs` so packaged apps embed `Sparkle.framework` under `Contents/Frameworks`.
- Updated `package-app.mjs` so release builds can opt into Sparkle by setting:
  - `MARKLAB_SPARKLE_FEED_URL`
  - `MARKLAB_SPARKLE_PUBLIC_ED_KEY`
- Updated package verification to assert:
  - `Sparkle.framework` is present;
  - `MarkLabApp` links against `@rpath/Sparkle.framework/Versions/B/Sparkle`;
  - `SUFeedURL` and `SUPublicEDKey` are present together when updates are configured;
  - Sparkle feed URLs use HTTPS.
- Added `package:update`, which:
  - packages `MarkLab.app` with version/build metadata;
  - creates a `.zip` with `ditto -c -k --sequesterRsrc --keepParent`;
  - writes release notes and a JSON manifest;
  - can run Sparkle's `generate_appcast` when an EdDSA private key is available.

## Dry-Run Verification

Command:

```sh
MARKLAB_SPARKLE_FEED_URL=https://updates.example.com/appcast.xml \
MARKLAB_SPARKLE_PUBLIC_ED_KEY=dummy-public-key \
MARKLAB_UPDATE_DOWNLOAD_URL_PREFIX=https://updates.example.com/downloads \
node apps/marklab-macos/scripts/package-update.mjs \
  --skip-build \
  --skip-appcast \
  --version 0.1.0-alpha.test \
  --build 2026052801
```

Result:

- Produced `dist/updates/MarkLab-0.1.0-alpha.test-2026052801/MarkLab.app`.
- Produced `dist/updates/appcast/MarkLab-0.1.0-alpha.test-2026052801.zip`.
- Produced `dist/updates/appcast/MarkLab-0.1.0-alpha.test-2026052801.html`.
- Produced `dist/updates/MarkLab-0.1.0-alpha.test-2026052801/release-manifest.json`.
- Manifest SHA-256 for the dry-run zip: `c926dc8dc77ab56c30a734eccab0468aceeafb5f5a649c2131d020b020479519`.

Verification command:

```sh
node apps/marklab-macos/scripts/verify-packaged-app.mjs \
  dist/updates/MarkLab-0.1.0-alpha.test-2026052801/MarkLab.app
```

Result:

- `ok: true`
- `sparkleLinked: true`
- `sparkleUpdatesConfigured: true`
- `sparkleFeedURL: https://updates.example.com/appcast.xml`
- `signingMode: ad-hoc`
- `developerIdSigned: false`
- `notarized: false`
- `distributionReady: false`

## Real Appcast Command Shape

For a real pilot update, the operator must first generate and retain the Sparkle EdDSA private key outside the repo, then package with the matching public key:

```sh
MARKLAB_SPARKLE_FEED_URL=https://<update-host>/appcast.xml \
MARKLAB_SPARKLE_PUBLIC_ED_KEY='<sparkle-public-ed-key>' \
MARKLAB_UPDATE_DOWNLOAD_URL_PREFIX=https://<update-host>/downloads \
MARKLAB_SPARKLE_ED_KEY_FILE=/path/to/private-ed25519-key \
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:update -- \
  --version 0.1.0-alpha.N \
  --build <monotonic-build-number>
```

`MARKLAB_SPARKLE_PRIVATE_ED_KEY` is also supported for automation, but file/keychain-backed signing is preferred so the private key is not committed or printed.

## Remaining To Close Gate 10.5

- Create/connect the GitHub Pages update host, or choose another stable HTTPS host.
- Decide the shared release-key custody model before generating a real Sparkle EdDSA keypair:
  - a release manager's macOS Keychain;
  - a CI secret scoped to update publishing;
  - or a team secret manager.
- Generate the real Sparkle EdDSA keypair only after custody is decided, and keep the private key out of the repo.
- Run `package:update` without `--skip-appcast` and verify signed `appcast.xml`.
- Install an older Sparkle-enabled app and verify `Check for Updates...` updates it to a newer build while preserving:
  - local files;
  - stored owner account;
  - workspace selection;
  - shared document bindings;
  - app support files;
  - browser links and cloud copies.
- Decide whether the private/beta channel accepts ad-hoc signing plus bounded Gatekeeper workaround, or complete Developer ID signing and notarization.
- Test rollback/downgrade instructions.

## Current Operator Guidance

Until the missing items above are complete:

- Build ordinary pilot apps without `MARKLAB_SPARKLE_FEED_URL` and `MARKLAB_SPARKLE_PUBLIC_ED_KEY` so `Check for Updates...` is not shown.
- Use bounded manual app replacement for named pilot users.
- Do not promise automatic updates in user-facing docs.
- Keep Gate 10.5 open.
