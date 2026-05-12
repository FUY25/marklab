# Hosted Relay Operations

Plan 04A operates one hosted relay/API/web deployment on Fly.io backed by Neon Postgres. The default alpha target is:

- Fly app: `marklab-relay-alpha`
- Fly region: Singapore, `sin`
- Neon region: AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`
- Web URL: `https://marklab-relay-alpha.fly.dev`
- API URL: `https://marklab-relay-alpha.fly.dev`
- Relay websocket URL: `wss://marklab-relay-alpha.fly.dev/relay`
- Provider websocket URL shape: `wss://marklab-relay-alpha.fly.dev/d/<providerDocId>/ws/<providerDocId>?token=...`

## Runtime Contract

The hosted relay must be started with:

```text
PORT=3001
DATABASE_URL=<neon-postgres-url-with-sslmode-require>
MARKLAB_REQUIRE_AUTH=true
MARKLAB_PUBLIC_WEB_URL=https://<fly-app>.fly.dev
MARKLAB_PUBLIC_API_URL=https://<fly-app>.fly.dev
MARKLAB_PUBLIC_RELAY_WS_URL=wss://<fly-app>.fly.dev/relay
MARKLAB_ALLOWED_ORIGINS=https://<fly-app>.fly.dev
MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS=86400
MARKLAB_RELAY_HOST_LEASE_SECONDS=30
MARKLAB_RELAY_MAX_ROOM_CONNECTIONS=32
MARKLAB_RELAY_MAX_MESSAGE_BYTES=1048576
MARKLAB_YSWEET_PROVIDER_MODE=process
MARKLAB_YSWEET_SERVER_URL=http://127.0.0.1:8080
MARKLAB_YSWEET_PUBLIC_URL_PREFIX=https://<fly-app>.fly.dev
MARKLAB_YSWEET_STORE_PATH=/data/ysweet
MARKLAB_YSWEET_HOST=127.0.0.1
MARKLAB_YSWEET_PORT=8080
MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS=10
MARKLAB_YSWEET_SKIP_GC=false
```

`DATABASE_URL` is a secret and must include `sslmode=require`. The public URL variables are not secret, but keep them in Fly secrets for one operator flow and to avoid drift between config files and runtime.

`MARKLAB_YSWEET_AUTH` and `MARKLAB_YSWEET_SERVER_TOKEN` are secrets generated together with:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api exec y-sweet gen-auth --json
```

Use the generated `private_key` as `MARKLAB_YSWEET_AUTH`; the API forwards it to the child provider as the upstream `Y_SWEET_AUTH` environment variable so it does not appear in process arguments. Use the generated `server_token` as `MARKLAB_YSWEET_SERVER_TOKEN`; MarkLab uses it for the Y-Sweet SDK connection string and `/check_store` health probe. These values are intentionally separate.

## Y-Sweet Provider Runtime

Plan 1B's alpha mode is an API-supervised upstream Y-Sweet process in the same Fly machine as the control-plane API. The API starts:

```bash
Y_SWEET_AUTH="$MARKLAB_YSWEET_AUTH" \
apps/api/node_modules/.bin/y-sweet serve "$MARKLAB_YSWEET_STORE_PATH" \
  --host "$MARKLAB_YSWEET_HOST" \
  --port "$MARKLAB_YSWEET_PORT" \
  --checkpoint-freq-seconds "$MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS" \
  --url-prefix "$MARKLAB_YSWEET_PUBLIC_URL_PREFIX" \
  --prod
```

The command is the upstream `y-sweet` server wrapper from the `y-sweet` npm package. MarkLab does not implement a custom Yjs sync protocol in the API process.

Public edit-capable clients receive Y-Sweet `ClientToken`s from the control plane. The token URL points at `MARKLAB_YSWEET_PUBLIC_URL_PREFIX`, so Fly must route Y-Sweet `/d/<providerDocId>/ws/<providerDocId>` websocket upgrades and token-scoped document HTTP routes (`/d/<providerDocId>/as-update`, `/d/<providerDocId>/update`) to the API. The API proxies only those document data routes to the child process at `MARKLAB_YSWEET_SERVER_URL`; management routes such as `/doc/new`, `/check_store`, and `/ready` stay internal. The API also accepts the upstream legacy `/doc/ws/*`, `/doc/<providerDocId>/as-update`, and `/doc/<providerDocId>/update` routes for compatibility, but current Y-Sweet 0.9.1 tokens use `/d/...`.

Local development provider data defaults to `.marklab-provider-data/ysweet`, which is git-ignored. Fly production stores provider data on the mounted volume at `/data/ysweet`. Y-Sweet also supports `s3://...` store paths with the upstream S3 environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `AWS_S3_USE_PATH_STYLE`), but the alpha target is a Fly volume.

Yjs garbage collection is left at the upstream default (`gc: true`; `MARKLAB_YSWEET_SKIP_GC=false`). The pinned Y-Sweet 0.9.1 server does not support a `--skip-gc` serve flag, so setting `MARKLAB_YSWEET_SKIP_GC=true` is rejected until a later provider upgrade proves that flag exists. Upstream Y-Sweet persists one checkpoint file per provider document (`<providerDocId>/data.ysweet`) on the checkpoint cadence. MarkLab alpha uses `MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS=10` in production and `1` in the automated smoke. There is no separate configurable "every 100 updates" knob in upstream Y-Sweet 0.9.1; the Plan 1B smoke writes 200 Yjs updates, gracefully restarts the provider, and verifies the restored `Y.Text("contents")` from the persisted checkpoint.

## Deploy And Inspect

Use the exact operator flow in [infra/fly/README.md](../../infra/fly/README.md):

```bash
fly launch --no-deploy --name marklab-relay-alpha --region sin
fly volumes create marklab_ysweet_data --region sin --size 1 -a marklab-relay-alpha
fly secrets set DATABASE_URL='<neon-postgres-url-with-sslmode-require>' ...
fly deploy
fly status
fly logs
curl https://<fly-app>.fly.dev/healthz
```

## Local Production Smoke

Run a local production-like stack with empty Postgres state:

```bash
docker compose -f infra/docker/docker-compose.prod-smoke.yml up --build
```

The compose stack starts:

- `postgres`, with a named local Docker volume;
- `migrate`, which applies `apps/api/src/db/schema.sql`;
- `api`, with hosted relay env values and `/healthz`;
- `web`, with static Vite output served by nginx.

To reset to a truly empty database:

```bash
docker compose -f infra/docker/docker-compose.prod-smoke.yml down -v
```

The compose migration service is intentionally explicit. If the API source integration adds a first-class migration command later, replace the `migrate` service command with that command and keep the empty-volume smoke behavior.

## Health Semantics

`/healthz` is the release gate for process liveness, database readiness, schema readiness, relay readiness, and provider readiness when the provider is required.

Operational interpretation:

- `process.ready` means the Node process accepts HTTP;
- `database.ready` means the API can connect to Neon or the smoke Postgres service;
- `schema.ready` means relay tables, grants, sessions, revisions, and cleanup metadata exist;
- `relay.ready` means `/relay` upgrades are enabled and governed by the same auth/origin/limit config.
- `provider.ready` means the Y-Sweet `/ready` endpoint is reachable and `/check_store` succeeds with the server token; `provider.storeReady` proves the provider has durable storage configured.

The local Docker smoke sets `MARKLAB_LOCAL_PRODUCTION_SMOKE=true` so it can use loopback HTTP/WS URLs while still exercising the production image, database, schema, and relay readiness path. Do not set that flag in Fly.

## Provider Smoke

Run the automated Y-Sweet provider smoke from the repository root:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api exec tsx src/provider/ysweet-provider-smoke.ts
```

The smoke starts the API and a Y-Sweet child process with generated test auth, requests an edit collab session through the API, connects an upstream Y-Sweet Yjs client, writes `Y.Text("contents")` plus 200 line updates, gracefully restarts the provider, and verifies the same text from the persisted provider store. Public view-link malicious-write smoke is intentionally skipped in v1 because public view links do not receive provider credentials.

## Alpha Host Authorization

Plan 04A uses anonymous public relay hosting for the first npm alpha. A local daemon may create a relay room without a MarkLab account, then receives a per-room host token that is kept inside the local daemon process. That host token can create view/edit grants, read share state, revoke grants for the same room, and mark that room host-offline.

This is intentionally not the final account model. A later hosted-login plan should replace anonymous room creation with account/session authorization while preserving the same local-file canonical model and the same public link shape.

Do not expose `MARKLAB_RELAY_MANAGEMENT_TOKEN` to user CLIs. That token, when configured, is for operator-only maintenance. The Plan 04A user path must not require it.

## Host Online Semantics

Host online means the MarkLab daemon is running and connected to the hosted relay. It does not mean only that the host computer is powered on.

Expected states:

- foreground CLI hosting stops when the terminal closes;
- background daemon hosting can continue after the launch command returns;
- closing the browser tab does not stop hosting if the daemon remains connected;
- sleep, network loss, daemon crash, or lease expiry marks the host offline;
- while host offline, browser editors and local mirror daemons cannot commit global writes.

## Relay Lifecycle

The relay stores metadata and ephemeral collaboration state only:

- relay rooms;
- token hashes, never raw tokens;
- access grants and sessions;
- host-online state and lease timestamps;
- accepted shared revision/hash for conflict detection;
- ephemeral Yjs/cache state with TTL.

Relay expiry is not document deletion. Expired relay state means the hosted cache or grant is unavailable; the local Markdown file remains wherever the participant stored it.

Stop sharing ends hosted relay access for that room. It does not delete local files.

Revoking one link removes access for sessions created through that grant. It does not delete the room, unrelated links, or any local file.

## Incident Checks

When a share link fails:

```bash
fly status
fly logs
curl https://<fly-app>.fly.dev/healthz
```

Then verify:

- `MARKLAB_PUBLIC_WEB_URL`, `MARKLAB_PUBLIC_API_URL`, and `MARKLAB_PUBLIC_RELAY_WS_URL` point at the same deployed app or the intended custom domain set;
- `MARKLAB_ALLOWED_ORIGINS` includes the web origin;
- `DATABASE_URL` includes `sslmode=require`;
- the host daemon is actually running and connected;
- the grant has not expired or been revoked.

Do not repair a relay incident by adding a hosted document-write endpoint. AI agents and local mirrors write local Markdown files and use the CLI/relay only for coordination.
