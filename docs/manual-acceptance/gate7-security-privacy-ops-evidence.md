# Gate 7 Security, Privacy, And Ops Evidence

Date started: 2026-05-28

Status: in progress for the small controlled pilot. This is not a public SLA, paid launch, account hard-delete, or full infrastructure restore drill.

## Scope

Gate 7 focuses on permission leaks, raw token leaks, local privacy, and operational recovery evidence for the current hosted native/Y-Sweet path:

- MarkLab.app owner sessions use hosted OIDC/login state.
- Browser collaborator links remain guest edit/view links.
- Provider access is API-supervised under `/d/<providerDocId>/...`.
- Neon stores metadata and token hashes.
- Fly stores provider document state on the `marklab_ysweet_data` volume at `/data/ysweet`.

Full Neon PITR and Fly volume restore drill remain deferred to the final launch gate before more than 10 users or any stronger public recovery claim.

## Evidence Matrix

| Gate 7 item | Current evidence | Status |
| --- | --- | --- |
| View links do not mount editable provider sessions | Gate 1 view-link smoke verified no CodeMirror/provider websocket for view mode. Current API coverage passed: `apps/api/src/routes/collab-session-routes.test.ts`, plus web app regression coverage in `apps/collab-web/src/App.test.tsx`. | Passed for pilot |
| Revoked edit links stop provider-token refresh and editing | Gate 1 revoked-edit lifecycle smoke verified refresh denial and post-revocation edit blocking. Current API coverage passed: `collab-session-routes.test.ts`, `access-routes.test.ts`, `access-control.test.ts`, `ysweet-provider-websocket-proxy.test.ts`, and `cloud-copy-routes.test.ts`. | Passed for pilot |
| Public browser traffic cannot spoof native `clientKind=app` | Gate 1 native bearer spoof check verified public links with `clientKind=app` are downgraded to browser behavior. Current route tests passed. | Passed for pilot |
| CORS/origin rules match hosted alpha assumptions | `apps/api/src/config/env.test.ts` passed. Native hosted WebView origin/callback hardening remains covered in Swift tests and Gate 6 smoke. | Passed for pilot |
| `/healthz` reports DB/schema/provider/store readiness | `curl -fsS https://marklab-relay-alpha.fly.dev/healthz` returned `ok: true`, `schema.missing: []`, `provider.ready: true`, and `provider.storeReady: true`. | Passed |
| Read-only and authenticated deployed alpha smoke | `MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev node scripts/marklab-alpha-smoke.mjs` passed. Authenticated smoke with `.env.marklab-pilot` passed and reported `planId: dev`, `memberSeats: 1000`, and `concurrentGuestEdits: 1000`. | Passed |
| Local file paths are treated as private/local context | Local app support files were checked under `~/Library/Application Support/MarkLab`; account, binding, baseline, and config files are `0600`. The native cursor debug log feature was removed and the local legacy `debug/cursor-debug.jsonl` file was deleted. | Passed for pilot |
| Support/debug instructions do not ask users to paste raw tokens | `rg` review found the production runbook warns not to commit/paste/share bootstrap token files. `docs/product/marklab-alpha-user-guide.md` now routes billing checks through UI first and, for operators, the ignored `.env.marklab-pilot` file instead of asking users to paste a raw token. | Passed for pilot |
| Fly rollback command exists | `docs/production/alpha-launch-runbook.md` records `fly releases -a marklab-relay-alpha` and `fly deploy --image <previous-image-ref> -a marklab-relay-alpha --yes`, with the note that Neon and Fly provider data are not rolled back by image redeploy. | Passed for pilot |
| Neon schema migration command exists | `docs/production/alpha-launch-runbook.md` records `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/src/db/schema.sql` plus a Fly SSH fallback that applies the checked-in schema from the running image. | Passed for pilot |
| Provider persistence restart smoke | Local provider restart/persistence smoke passed with `{"ok":true,"providerDocId":"ml_doc_smoke","linesWritten":200,"restoredBytes":1715,"storeFiles":1,"storeBytes":1810}`. Live Fly machine restart persistence smoke is still not run in this Gate 7 pass because it briefly disrupts active sessions. | Open |
| Raw access/share/provider/session tokens are not logged | Source/doc scan found no current support instruction asking users to paste raw tokens; native cursor debug logging was removed. A live Fly log audit is still open before marking this line fully passed. | Open |

## Commands Run

```sh
curl -fsS https://marklab-relay-alpha.fly.dev/healthz

MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev \
node scripts/marklab-alpha-smoke.mjs

set -a
source ./.env.marklab-pilot
set +a
MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 \
node scripts/marklab-alpha-smoke.mjs

npx -y pnpm@10.0.0 exec vitest run \
  apps/api/src/routes/collab-session-routes.test.ts \
  apps/api/src/services/access-control.test.ts \
  apps/api/src/routes/access-routes.test.ts \
  apps/api/src/http/app.test.ts \
  apps/api/src/config/env.test.ts \
  apps/api/src/provider/ysweet-provider-websocket-proxy.test.ts \
  apps/api/src/routes/cloud-copy-routes.test.ts \
  apps/api/src/services/lifecycle-cleanup-service.test.ts

npx -y pnpm@10.0.0 exec vitest run \
  apps/collab-web/src/editor/native-bridge.test.ts \
  apps/collab-web/src/App.test.tsx

npx -y pnpm@10.0.0 typecheck

swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests

npx -y pnpm@10.0.0 --filter @marklab/api exec tsx src/provider/ysweet-provider-smoke.ts

npx -y pnpm@10.0.0 test

swift test --package-path apps/marklab-macos
```

Results:

- API security/lifecycle suite: 8 files passed, 144 tests passed.
- Web native bridge/app suite: 2 files passed, 24 tests passed.
- Swift `MarkLabAppModelTests`: 38 tests passed.
- TypeScript typecheck: passed.
- Local provider restart/persistence smoke: passed, with two benign duplicate connect-loop warnings already seen in earlier runs.
- Full root Vitest suite: 66 files passed, 1 skipped; 529 tests passed, 1 skipped.
- Full SwiftPM native suite: 101 tests passed.

## Changes Made During Gate 7

- Removed the native cursor debug log feature entirely:
  - removed web `cursor-debug` bridge message and diagnostic sampling;
  - removed the native WKWebView `cursor-debug` message handler;
  - removed the bridge test for cursor diagnostics;
  - deleted the local legacy `~/Library/Application Support/MarkLab/debug/cursor-debug.jsonl` file.
- Updated alpha user-guide billing-check wording so support does not ask users to paste raw tokens.

## Remaining Before Gate 7 Can Pass

- Run a live Fly log audit for raw tokens/local paths/content, or record a deliberately bounded deferral if the small pilot accepts source-level evidence only.
- Run the live Fly machine restart persistence smoke from `docs/production/alpha-launch-runbook.md` when no active user is editing, then verify `/healthz` and an existing edit link still recover provider state from `/data/ysweet`.
