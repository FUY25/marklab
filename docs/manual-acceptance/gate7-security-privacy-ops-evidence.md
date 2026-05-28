# Gate 7 Security, Privacy, And Ops Evidence

Date started: 2026-05-28

Status: passed for the small controlled pilot. This is not a public SLA, paid launch, account hard-delete, or full infrastructure restore drill.

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
| Provider persistence restart smoke | Local provider restart/persistence smoke passed with `{"ok":true,"providerDocId":"ml_doc_smoke","linesWritten":200,"restoredBytes":1715,"storeFiles":1,"storeBytes":1810}`. Live Fly machine restart smoke on release `v32` wrote a disposable marker, restarted machine `0803d9dc665328`, then verified the marker from provider update after restart. | Passed |
| Raw access/share/provider/session tokens are not logged | Source/doc scan found no current support instruction asking users to paste raw tokens; native cursor debug logging was removed. Live Fly log audit over the latest 100 lines found no matches for raw access/user tokens, Google client secret prefix, auth headers, provider/client token names, DB/OIDC secret names, local paths, or disposable Gate 7 marker/content. | Passed for pilot |
| Access revocation cleanup does not leave live provider access | Gate 7 live smoke found and fixed two revocation edge bugs: runtime close cleanup is best effort after DB revocation, and nullable branch UUID SQL parameters are explicitly cast for real PostgreSQL. Release `v32` disposable smoke verified access-grant DELETE returned 204, the revoked token was denied with 403, cloud copy deletion succeeded, and Neon had no remaining grant/session/provider-token rows for the disposable grants. | Passed |

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

fly logs -a marklab-relay-alpha --no-tail > /tmp/marklab-gate7-v32-logs.txt
rg -n "ml_access_|ml_user_|GOCSPX|Authorization|Bearer|token=|refreshToken|providerToken|clientToken|DATABASE_URL|OIDC_CLIENT_SECRET|/Users/|Desktop/|markdown_ai_collab|Gate 7 disposable|gate7-live-restart" /tmp/marklab-gate7-v32-logs.txt || true

# Disposable live Fly restart/revocation smoke:
# import workspace doc, create edit access grant, open hosted provider edit session,
# write marker through Y-Sweet, restart Fly machine, read marker after restart,
# revoke grant, verify revoked token denial, delete cloud copy, verify no DB residue.

npx -y pnpm@10.0.0 test

swift test --package-path apps/marklab-macos
```

Results:

- API security/lifecycle suite: 8 files passed, 145 tests passed after revocation hardening.
- Web native bridge/app suite: 2 files passed, 24 tests passed.
- Swift `MarkLabAppModelTests`: 38 tests passed.
- TypeScript typecheck: passed.
- Local provider restart/persistence smoke: passed, with two benign duplicate connect-loop warnings already seen in earlier runs.
- Full root Vitest suite: 66 files passed, 1 skipped; 529 tests passed, 1 skipped.
- Full SwiftPM native suite: 101 tests passed.
- Live Fly log audit: 100 latest log lines scanned, no matches for raw tokens/secrets/local paths/disposable content.
- Live Fly restart/revocation smoke on release `v32`: passed with disposable `docId` `f96378e6-7706-4e46-8ea1-917c77159b33`, `branchId` `e6ecf4c7-7cb6-4bdf-ab9a-7f41ced0c3a3`, and `grantId` `641ca95f-559c-4ec1-bbbb-de71a7bdde4f`; marker persisted after restart, revoke returned 204, revoked token was denied with 403, and cloud copy deletion removed provider doc `ml_doc_f90213fc-c93b-4cda-8f04-cbfc6afde980`.
- Disposable cleanup verification: Neon returned no remaining `document_access_grants`, `collab_sessions`, or `provider_token_issuances` rows for the failed v31 smoke grant `688fa679-1e3e-4ed1-a683-7dfde6dfe94d` or the passing v32 smoke grant `641ca95f-559c-4ec1-bbbb-de71a7bdde4f`.

## Changes Made During Gate 7

- Removed the native cursor debug log feature entirely:
  - removed web `cursor-debug` bridge message and diagnostic sampling;
  - removed the native WKWebView `cursor-debug` message handler;
  - removed the bridge test for cursor diagnostics;
  - deleted the local legacy `~/Library/Application Support/MarkLab/debug/cursor-debug.jsonl` file.
- Updated alpha user-guide billing-check wording so support does not ask users to paste raw tokens.
- Hardened access-grant/link/agent revocation cleanup so DB revocation remains authoritative even if runtime socket cleanup throws.
- Fixed real PostgreSQL nullable branch UUID revocation queries by casting nullable branch parameters as `uuid`, with a regression guard in access-route tests.

## Hosted Alpha Deploy

Commit `0ec173fd1edc1f65dd244749c8b4f78bdc570c39` was deployed to Fly release `v30` with image `registry.fly.io/marklab-relay-alpha:deployment-01KSPWYRP29R85TTEHKZD3RM26`.

Post-deploy checks:

- `/healthz`: `ok: true`, `schema.missing: []`, `provider.ready: true`, `provider.storeReady: true`.
- Read-only alpha smoke: passed.
- Authenticated alpha smoke: passed with manual billing `planId: dev`, `memberSeats: 1000`, `concurrentGuestEdits: 1000`.
- `fly status` reported machine `0803d9dc665328`, version `30`, started, with `1 total, 1 passing` check.
- `fly checks list` reported `servicecheck-00-http-3001` passing.
- `fly ips list` reported IPv6 `2a09:8280:1::10f:9226:0` and IPv4 `66.241.124.14`.

The Fly deploy command printed a transient startup listener warning before the machine reached a good state, and a DNS AAAA warning even though `fly ips list` reported the IPv6 ingress. Subsequent health, checks, status, and smokes passed.

## Gate 7 Closure Deploy

Commit `e7c1c3b23ff54bd972c63fc5801f7f8d1c3baf95` was deployed to Fly release `v32` with image `registry.fly.io/marklab-relay-alpha:deployment-01KSPYX7X6GYNZGEMHSB938W4E`.

Post-deploy checks:

- `/healthz`: `ok: true`, `schema.missing: []`, `provider.ready: true`, `provider.storeReady: true`.
- Read-only/static alpha smoke: passed.
- Authenticated alpha smoke: passed with manual billing `planId: dev`, `memberSeats: 1000`, `concurrentGuestEdits: 1000`.
- `fly status` reported machine `0803d9dc665328`, version `32`, started, with `1 total, 1 passing` check.
- Live Fly restart/revocation smoke passed and cleaned its disposable cloud copy.
- Live Fly log audit passed for the bounded small-pilot log window.

## Residual Limitations

- This is a small-pilot evidence pass, not a full security audit or public compliance claim.
- Full Neon PITR and Fly volume restore drill remains deferred to the final launch gate before more than 10 users or stronger public RPO/RTO claims.
- Workspace/account hard delete remains deferred.
- Paid Stripe flows remain intentionally disabled.
- Browser collaborators still participate in versioning through provider writes and server autosave, but browser has no version-control UI.
