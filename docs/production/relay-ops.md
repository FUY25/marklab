# Hosted Relay Operations

Plan 04A operates one hosted relay/API/web deployment on Fly.io backed by Neon Postgres. The default alpha target is:

- Fly app: `marklab-relay-alpha`
- Fly region: Singapore, `sin`
- Neon region: AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`
- Web URL: `https://marklab-relay-alpha.fly.dev`
- API URL: `https://marklab-relay-alpha.fly.dev`
- Relay websocket URL: `wss://marklab-relay-alpha.fly.dev/relay`

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
```

`DATABASE_URL` is a secret and must include `sslmode=require`. The public URL variables are not secret, but keep them in Fly secrets for one operator flow and to avoid drift between config files and runtime.

## Deploy And Inspect

Use the exact operator flow in [infra/fly/README.md](../../infra/fly/README.md):

```bash
fly launch --no-deploy --name marklab-relay-alpha --region sin
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

`/healthz` is the release gate for process liveness, database readiness, schema readiness, and relay readiness.

Operational interpretation:

- `process.ready` means the Node process accepts HTTP;
- `database.ready` means the API can connect to Neon or the smoke Postgres service;
- `schema.ready` means relay tables, grants, sessions, revisions, and cleanup metadata exist;
- `relay.ready` means `/relay` upgrades are enabled and governed by the same auth/origin/limit config.

The local Docker smoke sets `MARKLAB_LOCAL_PRODUCTION_SMOKE=true` so it can use loopback HTTP/WS URLs while still exercising the production image, database, schema, and relay readiness path. Do not set that flag in Fly.

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
