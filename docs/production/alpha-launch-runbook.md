# MarkLab Alpha Launch Runbook

Date: 2026-05-18

This runbook is the operator contract for the current MarkLab alpha. It covers the new hosted control-plane/Y-Sweet relay and native MarkLab.app path. It does not use the archived local daemon route.

## Topology

- Fly.io app: `marklab-relay-alpha`
- Public origin: `https://marklab-relay-alpha.fly.dev`
- API/control plane: same Fly origin under `/api/*`
- Browser app: same Fly origin at `/collab` with static assets under `/collab-web/*`
- Workspace settings: same Fly origin at `/workspaces/:workspaceId/settings`
- Provider: upstream Y-Sweet process supervised by the API on `127.0.0.1:8080`, public provider document routes proxied at the API root under `/d/<providerDocId>/...`
- Database: Neon Postgres through `DATABASE_URL`
- Provider persistence: Fly volume `marklab_ysweet_data` mounted at `/data`, with Y-Sweet store path `/data/ysweet`
- Billing mode for private alpha: `manual` / free limits only. Stripe checkout, portal, webhooks, and paid plan selection are intentionally not enabled.
- Native distribution source: `apps/marklab-macos`
- CLI package source: `apps/cli`

## Required Secrets And Env

Required Fly secrets:

- `DATABASE_URL`
- `MARKLAB_REQUIRE_AUTH=true`
- `MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev`
- `MARKLAB_PUBLIC_API_URL=https://marklab-relay-alpha.fly.dev`
- `MARKLAB_ALLOWED_ORIGINS=https://marklab-relay-alpha.fly.dev`
- `MARKLAB_YSWEET_AUTH`
- `MARKLAB_YSWEET_SERVER_TOKEN`

Required Fly non-secret env is checked into `fly.toml`:

- `MARKLAB_YSWEET_PROVIDER_MODE=process`
- `MARKLAB_YSWEET_SERVER_URL=http://127.0.0.1:8080`
- `MARKLAB_YSWEET_PUBLIC_URL_PREFIX=https://marklab-relay-alpha.fly.dev`
- `MARKLAB_YSWEET_STORE_PATH=/data/ysweet`
- `MARKLAB_YSWEET_HOST=127.0.0.1`
- `MARKLAB_YSWEET_PORT=8080`
- `MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS=10`
- `MARKLAB_YSWEET_SKIP_GC=false`

List secret names without printing values:

```sh
fly secrets list -a marklab-relay-alpha
```

## Build, Migrate, And Deploy

Use manual Fly deploy for the private alpha.

```sh
npx -y pnpm@10.0.0 install
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test
swift test --package-path apps/marklab-macos
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package
```

Apply the checked-in schema to Neon before deploying an image that depends on new readiness columns. Fly machine health checks call `/livez` and intentionally avoid Neon; `/healthz` remains the release gate for database and schema readiness.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/src/db/schema.sql
```

If the operator does not have the Neon `DATABASE_URL` locally but the Fly secret is already configured, apply the same checked-in schema from inside the running Fly machine without printing the secret:

```sh
fly ssh console -a marklab-relay-alpha -C "cd /app/apps/api && node --input-type=module -e \"import { readFileSync } from 'node:fs'; import pg from 'pg'; const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); await client.query(readFileSync('/app/apps/api/src/db/schema.sql', 'utf8')); await client.end(); console.log('schema_applied');\""
```

Deploy after schema readiness is in place:

```sh
git rev-parse HEAD
fly deploy -a marklab-relay-alpha --local-only --depot=false --wait-timeout 10m --yes
```

Record the deployed commit SHA in the launch notes. Operators can also inspect the current Fly image and machines:

```sh
fly status -a marklab-relay-alpha
fly releases -a marklab-relay-alpha
fly machines list -a marklab-relay-alpha
```

## Database Readiness

The current migration path is the checked-in schema file. It is expected to be safe to re-run:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/src/db/schema.sql
```

If `/healthz` reports missing schema columns and local Neon credentials are unavailable, use the Fly-machine fallback from `Build, Migrate, And Deploy`, then re-check health before continuing.

The launch gate is not just "SQL ran"; `/healthz` must show database, schema, provider, and provider store ready. `/livez` should also pass, but it does not validate database or schema readiness.

```sh
curl -fsS https://marklab-relay-alpha.fly.dev/healthz | jq .
curl -fsS https://marklab-relay-alpha.fly.dev/livez | jq .
```

Required health:

```json
{
  "ok": true,
  "database": { "ready": true },
  "schema": { "ready": true, "missing": [] },
  "provider": { "ready": true, "storeReady": true }
}
```

## Pilot Owner Bootstrap

Production disables `/api/auth/dev-login`; do not rely on dev auth for alpha pilots.

Primary Gate 6 owner path is hosted OIDC:

1. Configure `MARKLAB_OIDC_ISSUER`, `MARKLAB_OIDC_CLIENT_ID`, `MARKLAB_OIDC_CLIENT_SECRET`, and `MARKLAB_OIDC_REDIRECT_URI`.
2. Deploy the API/web app.
3. Open MarkLab.app, then `Settings` -> `Account` -> `Sign In`.
4. Complete OIDC in the browser and allow the `marklab://auth/callback` handoff.
5. Confirm the app reports the signed-in owner and selected/created workspace before sharing.

The app stores the owner session locally and sends the OIDC display name to hosted `/collab` app sessions for cursor/presence display. Browser edit/view links remain guest links and do not require collaborator login.

### Google OIDC Setup

Use this when the pilot owner login button says `Continue with Google`.

1. In Google Cloud Console, create or select the MarkLab pilot project.
2. Configure the Google Auth / OAuth consent screen:
   - Audience: `External`, unless the pilot is limited to one Google Workspace organization.
   - Publishing status:
     - Use `Testing` only when you are willing to add every pilot owner as a test user.
     - Use `In production` when controlled-discovery self-serve sign-in should work for any Google Account that receives the app URL.
   - App name: `MarkLab`.
   - User support email and developer contact email: an operator email you monitor.
   - Scopes: only `openid`, `email`, and `profile`.
   - Test users: add every pilot owner email if Google requires test users for the selected audience/status.
3. Create an OAuth client:
   - Application type: `Web application`.
   - Name: `MarkLab Alpha`.
   - Authorized JavaScript origin: `https://marklab-relay-alpha.fly.dev`.
   - Authorized redirect URI: `https://marklab-relay-alpha.fly.dev/auth/callback`.
4. Store the client ID and client secret outside the repo, then set Fly secrets:
   ```sh
   fly secrets set -a marklab-relay-alpha \
     MARKLAB_OIDC_ISSUER=https://accounts.google.com \
     MARKLAB_OIDC_CLIENT_ID='<google-client-id>' \
     MARKLAB_OIDC_CLIENT_SECRET='<google-client-secret>' \
     MARKLAB_OIDC_REDIRECT_URI=https://marklab-relay-alpha.fly.dev/auth/callback
   ```
5. Confirm the secrets are present without printing values:
   ```sh
   fly secrets list -a marklab-relay-alpha | rg 'MARKLAB_OIDC_(ISSUER|CLIENT_ID|CLIENT_SECRET|REDIRECT_URI)'
   ```

Do not set `MARKLAB_OIDC_AUTHORIZATION_ENDPOINT` for Google unless discovery is failing; the API can discover Google endpoints from `https://accounts.google.com/.well-known/openid-configuration`.

For the small pilot, `In production` in Google OAuth does not mean MarkLab itself is publicly launched; it only removes Google's test-user allowlist requirement. Keep product discovery controlled operationally until Gate 9. If Google requires brand verification for the configured app name/logo or authorized domain, complete that in Google Cloud before relying on broad Google sign-in.

Local pre-provider regression check:

```sh
npx -y pnpm@10.0.0 smoke:oidc-local
```

This starts a local mock OIDC provider plus the API, verifies discovery, authorize, code exchange, userinfo, bearer session auth, workspace list/create, and a redacted `marklab://auth/callback` shape. It does not replace the hosted smoke against the real OIDC provider after `MARKLAB_OIDC_*` secrets are configured.

Fallback operator bootstrap remains available for smoke testing or incidents. Use it from the operator machine with direct Neon access:

```sh
BOOTSTRAP_JSON=$(mktemp "${TMPDIR:-/tmp}/marklab-alpha-bootstrap.XXXXXX.json")
chmod 600 "$BOOTSTRAP_JSON"

MARKLAB_BOOTSTRAP_EMAIL=<pilot-owner@example.com> \
MARKLAB_BOOTSTRAP_NAME='Pilot Owner' \
MARKLAB_BOOTSTRAP_WORKSPACE_NAME='MarkLab Alpha Pilot' \
MARKLAB_BOOTSTRAP_PLAN_ID=dev \
node scripts/marklab-bootstrap-alpha-user.mjs > "$BOOTSTRAP_JSON"

export MARKLAB_USER_TOKEN=$(jq -r .userToken "$BOOTSTRAP_JSON")
export MARKLAB_WORKSPACE_ID=$(jq -r .workspaceId "$BOOTSTRAP_JSON")
```

By default, the script revokes previous active sessions for the same owner email before issuing the new 30-day `ml_user_...` token. Set `MARKLAB_BOOTSTRAP_ROTATE_SESSIONS=0` only if you deliberately need multiple active owner tokens during an incident. Treat `$BOOTSTRAP_JSON` as a secret handoff file: do not commit it, paste it into docs, or send it to guests. Browser/app collaborators should receive edit/view links created from MarkLab.app, not the owner token.

## Smoke Commands

Read-only alpha smoke for process/schema/provider/static-shell readiness:

```sh
MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev \
node scripts/marklab-alpha-smoke.mjs
```

Launch-gate smoke with authenticated manual/free billing state:

```sh
MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 \
MARKLAB_USER_TOKEN=<ml_user_...> \
MARKLAB_WORKSPACE_ID=<workspace-id> \
node scripts/marklab-alpha-smoke.mjs
```

Local harnesses are useful regression checks but do not prove deployed Fly volume persistence or packaged native behavior against the live origin.

Native/browser local smoke:

```sh
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser
```

Provider persistence smoke for local/API-supervised provider runtime:

```sh
npx -y pnpm@10.0.0 --filter @marklab/api exec tsx src/provider/ysweet-provider-smoke.ts
```

Production persistence smoke:

- Start a real app/browser edit session against `https://marklab-relay-alpha.fly.dev`.
- Type a unique marker in the shared document.
- Restart the Fly machine with `fly machine restart <machine-id> -a marklab-relay-alpha`.
- Reopen the same edit link and confirm the marker is still present after the provider process restarts and reads `/data/ysweet`.

Manual production smoke checklist:

- Open `/collab` and confirm the app shell loads.
- Open `/workspaces/<workspace-id>/settings` and confirm Members, Documents, and Plan & Billing tabs load.
- In MarkLab.app, open a local `.md`, click `Start Sharing`, create an edit link, and confirm the link is copied.
- Open the edit link in a browser and coedit with the app.
- Open the same edit link in another MarkLab.app instance/user profile, choose a folder, and confirm the local file is created with the shared document name.
- Revoke the edit link and confirm new joins fail with an unavailable/revoked state.
- Confirm a view link does not mount an editable editor.
- Confirm manual/free guest edit quota errors surface as `guest_session_quota_exceeded` when exceeded.

Record command, timestamp, result, and commit SHA for each launch smoke.

## Rollback

Rollback the app image:

```sh
fly releases -a marklab-relay-alpha
fly deploy --image <previous-image-ref> -a marklab-relay-alpha --yes
```

If rollback uses Fly's release id path instead of image refs, record the exact `fly releases` output in the incident notes before changing anything.

Database and provider persistence are not rolled back by redeploying an image. User data is preserved in Neon and in the Fly volume. If a schema change is involved, snapshot/branch Neon before manual repair. Do not delete the Fly volume during rollback.

## Observability

Primary checks:

```sh
fly status -a marklab-relay-alpha
fly checks list -a marklab-relay-alpha
fly logs -a marklab-relay-alpha
curl -fsS https://marklab-relay-alpha.fly.dev/healthz | jq .
```

Investigate by layer:

- Database unavailable: check `DATABASE_URL`, Neon status, and schema task.
- Schema missing: apply `apps/api/src/db/schema.sql` and re-check `/healthz`.
- Provider not ready: check `MARKLAB_YSWEET_AUTH`, `MARKLAB_YSWEET_SERVER_TOKEN`, child process logs, and `/data/ysweet` mount.
- Store not ready: check Fly volume attachment and writable `/data/ysweet`.
- Auth failures: check OIDC/user-session config and ensure production is not relying on dev login.
- Quota failures: check `/api/workspaces/:workspaceId/billing` and `seat_limits`.
- Link failures: check grant revocation/expiry and provider-token refresh errors.

## Pilot Packaged App Start

Normal pilot owners should use the packaged app and hosted OIDC path:

```sh
unzip MarkLab-controlled-pilot.zip
mv MarkLab.app /Applications/
open /Applications/MarkLab.app
```

If macOS blocks the current ad-hoc signed controlled-pilot artifact, use only the scoped per-app Gatekeeper workaround and then open the app again:

```sh
xattr -dr com.apple.quarantine /Applications/MarkLab.app
open /Applications/MarkLab.app
```

In the app, open `Settings` -> `Account` -> `Sign In`, choose `Continue with Google`, complete hosted OIDC in the browser, and allow the `marklab://auth/callback` handoff. The app should show the signed-in owner and a selected or newly created workspace before the owner starts sharing.

## Operator Fallback Dev Start

Use this only for smoke testing or incidents when the packaged OIDC path is unavailable. It is not the normal pilot-owner start path:

```sh
MARKLAB_CONTROL_PLANE_API_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_USER_TOKEN=<ml_user_...> \
MARKLAB_WORKSPACE_ID=<workspace-id> \
swift run --package-path apps/marklab-macos MarkLabApp
```

For normal collaborators, send the browser/app edit link created by MarkLab.app. They should not need provider URLs, Y-Sweet secrets, Neon credentials, Fly credentials, or the archived daemon CLI.
