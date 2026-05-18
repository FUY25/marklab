# Hosted Relay And Provider Operations

This page describes the new relay/native pilot deployment shape.

The intended external pilot target can reuse Fly.io plus Neon, but the deployed service must be the current control-plane/Y-Sweet stack, not the archived anonymous relay daemon stack.

## Target Shape

- Fly.io app serves the API, `/collab` static app, auth/workspace/document routes, access grants, collab-session routes, and API-root provider proxy routes.
- Neon Postgres stores users, workspaces, documents, branches, access grants, sessions, and versions.
- A Fly volume stores Y-Sweet provider data at `/data/ysweet`.
- Browser and native app clients open `/collab?docId=...&branchId=...&token=...&mode=edit|view`.
- Clients receive Y-Sweet `ClientToken`s from the control plane; they do not configure provider websocket URLs themselves.

## Required Runtime

```text
PORT=3001
DATABASE_URL=<neon-postgres-url-with-sslmode-require>
MARKLAB_REQUIRE_AUTH=true
MARKLAB_PUBLIC_WEB_URL=https://<fly-app>.fly.dev
MARKLAB_PUBLIC_API_URL=https://<fly-app>.fly.dev
MARKLAB_ALLOWED_ORIGINS=https://<fly-app>.fly.dev
MARKLAB_COLLAB_WEB_DIST_DIR=/app/apps/collab-web/dist
MARKLAB_YSWEET_PROVIDER_MODE=process
MARKLAB_YSWEET_SERVER_URL=http://127.0.0.1:8080
MARKLAB_YSWEET_PUBLIC_URL_PREFIX=https://<fly-app>.fly.dev
MARKLAB_YSWEET_STORE_PATH=/data/ysweet
MARKLAB_YSWEET_HOST=127.0.0.1
MARKLAB_YSWEET_PORT=8080
MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS=10
MARKLAB_YSWEET_SKIP_GC=false
```

Generate Y-Sweet auth values with:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api exec y-sweet gen-auth --json
```

Set:

- `MARKLAB_YSWEET_AUTH` from `private_key`.
- `MARKLAB_YSWEET_SERVER_TOKEN` from `server_token`.

These are secrets. Do not expose them to CLI users, browser clients, or logs.

## Deploy Checklist

1. Build `apps/collab-web` and include the dist directory in the API image.
2. Apply `apps/api/src/db/schema.sql` to Neon.
3. Mount a Fly volume at `/data/ysweet`.
4. Configure the runtime env above.
5. Deploy the API image.
6. Verify `/healthz`.
7. Run a disposable workspace/document/access-grant smoke.
8. Run native app and browser acceptance against the deployed URL.

The detailed alpha launch checklist, rollback procedure, and smoke result log live in [Alpha Launch Runbook](alpha-launch-runbook.md).

## Health Semantics

`/healthz` is the release gate.

Required signals:

- `process.ready`: HTTP process accepts requests.
- `database.ready`: API can connect to Neon.
- `schema.ready`: required tables and columns are present.
- `provider.ready`: API can reach the supervised Y-Sweet provider.
- `provider.storeReady`: provider storage is configured and writable.

The pilot is not externally ready until `provider.ready` and `provider.storeReady` are both true.

## Provider Routes

Public clients receive provider URLs through control-plane session/token responses.

The public provider route shape is:

```text
https://<fly-app>.fly.dev/d/<providerDocId>/...
wss://<fly-app>.fly.dev/d/<providerDocId>/ws/<providerDocId>
```

Management routes such as `/doc/new`, `/check_store`, and `/ready` stay internal to the API/provider boundary.

## Local Production Smoke

Run a local production-like stack with empty Postgres state:

```bash
docker compose -f infra/docker/docker-compose.prod-smoke.yml up --build
```

Reset it with:

```bash
docker compose -f infra/docker/docker-compose.prod-smoke.yml down -v
```

## Provider Smoke

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api exec tsx src/provider/ysweet-provider-smoke.ts
```

The smoke should create an edit collab session, connect a Y-Sweet Yjs client, write text, restart the provider, and verify persisted state.

## Alpha Smoke

Run the read-only production smoke against the deployed origin:

```bash
MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev \
node scripts/marklab-alpha-smoke.mjs
```

To include the manual/free billing-state check, add a pilot user token and workspace id:

```bash
MARKLAB_USER_TOKEN=<ml_user_...> \
MARKLAB_WORKSPACE_ID=<workspace-id> \
node scripts/marklab-alpha-smoke.mjs
```

This smoke does not create documents or links by default. Product creation/revocation checks remain explicit launch-smoke steps in the alpha launch runbook.

## Incident Checks

When a shared link fails:

```bash
fly status
fly logs
curl https://<fly-app>.fly.dev/healthz
```

Then verify:

- schema has been applied to Neon;
- `MARKLAB_COLLAB_WEB_DIST_DIR` points to the built `/collab` app;
- `MARKLAB_ALLOWED_ORIGINS` includes the deployed web origin;
- Y-Sweet auth secrets are paired correctly;
- `/data/ysweet` is mounted and writable;
- the access grant has not expired or been revoked.

Do not repair a production incident by adding a hosted agent write endpoint. Agents edit local Markdown files and the native app ingests those changes.
