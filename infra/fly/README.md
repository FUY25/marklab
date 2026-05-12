# Fly.io And Neon Alpha Relay Setup

This is the Plan 04A operator path for the hosted MarkLab relay. Fly.io and Neon are the first production target; Docker remains the portability boundary for later Render, Railway, or VPS deployments.

## Target Regions

- Fly.io region: Singapore, `sin`
- Neon region: AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`

Keep Fly and Neon in Singapore for the alpha. Moving one without the other increases latency for relay metadata and host-online checks.

## 1. Create Accounts

Create or confirm access to:

- a Fly.io account;
- a Neon account;
- a Neon project in AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`.

The default Fly app name is `marklab-relay-alpha`. Use it unless Fly reports the name is unavailable. If you choose another app name, replace every URL and every `<fly-app>` placeholder in this document with the chosen name.

The Plan 04A Fly image serves the API, relay websocket, and built web app from the same Fly hostname. Browser relay links such as `/relay/<room>` must resolve on this app; do not deploy an API-only image for the alpha.

Plan 1B also co-locates the upstream Y-Sweet provider in the same Fly machine. The API supervises a child `y-sweet serve` process on `127.0.0.1:8080`, stores provider checkpoints on a Fly volume at `/data/ysweet`, and proxies public Y-Sweet document routes to that child process. Current Y-Sweet 0.9.1 client tokens use `/d/<providerDocId>/ws/<providerDocId>` for websocket sync plus `/d/<providerDocId>/as-update` and `/d/<providerDocId>/update` for token-scoped document HTTP traffic.

Plan 04A uses anonymous public relay room creation for the npm alpha. The daemon gets a per-room host token and uses that token for room-scoped link creation, share-state reads, grant revocation, and host-offline marking. Do not give ordinary users a global relay management token. Account login is a later hosted-auth plan.

Run the Plan 04A alpha as one Fly machine:

```bash
fly scale count 1 -a marklab-relay-alpha --yes
```

Relay websocket sessions, host-online state, immediate revoke disconnects, and the co-located provider volume are single-machine assumptions for the alpha. Scaling to multiple machines requires a later sticky-routing or shared relay/provider fanout change.

## 2. Install And Authenticate Fly CLI

```bash
brew install flyctl
fly auth login
```

If Homebrew is not available, install Fly CLI with Fly's shell installer. Homebrew is only an operator dependency here; MarkLab is not documented as a Homebrew-distributed app in Plan 04A.

## 3. Create The Neon Database

In Neon:

1. Create a project such as `marklab-alpha`.
2. Select AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`.
3. Keep the default database and role, or create a dedicated `marklab` database and `marklab_app` role.
4. Copy the connection string.
5. Confirm the connection string includes `sslmode=require`.

Use the direct Neon connection string as `DATABASE_URL` for Plan 04A. Do not commit it.

## 4. Create The Fly App

From the repository root:

```bash
fly launch --no-deploy --name marklab-relay-alpha --region sin
```

If `marklab-relay-alpha` is unavailable:

```bash
fly launch --no-deploy --name <fly-app> --region sin
```

If Fly generates a local `fly.toml`, compare it against `infra/fly/fly.toml.example`. The checked-in example is the contract for Plan 04A and must contain no secrets.

Create the provider volume before deploying:

```bash
fly volumes create marklab_ysweet_data --region sin --size 1 -a marklab-relay-alpha
```

For a different app name:

```bash
fly volumes create marklab_ysweet_data --region sin --size 1 -a <fly-app>
```

## 5. Set Runtime Secrets And Public URLs

Generate Y-Sweet provider auth values from the repo:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api exec y-sweet gen-auth --json
```

Use `private_key` for `MARKLAB_YSWEET_AUTH`. Use `server_token` for `MARKLAB_YSWEET_SERVER_TOKEN`. They are a matched pair; do not invent one from the other by hand.

For the default app name:

```bash
fly secrets set \
  DATABASE_URL='<neon-postgres-url-with-sslmode-require>' \
  MARKLAB_REQUIRE_AUTH='true' \
  MARKLAB_PUBLIC_WEB_URL='https://marklab-relay-alpha.fly.dev' \
  MARKLAB_PUBLIC_API_URL='https://marklab-relay-alpha.fly.dev' \
  MARKLAB_PUBLIC_RELAY_WS_URL='wss://marklab-relay-alpha.fly.dev/relay' \
  MARKLAB_ALLOWED_ORIGINS='https://marklab-relay-alpha.fly.dev' \
  MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS='86400' \
  MARKLAB_RELAY_HOST_LEASE_SECONDS='30' \
  MARKLAB_RELAY_MAX_ROOM_CONNECTIONS='32' \
  MARKLAB_RELAY_MAX_MESSAGE_BYTES='1048576' \
  MARKLAB_YSWEET_AUTH='<private_key-from-y-sweet-gen-auth>' \
  MARKLAB_YSWEET_SERVER_TOKEN='<server_token-from-y-sweet-gen-auth>'
```

For a different app name:

```bash
fly secrets set \
  DATABASE_URL='<neon-postgres-url-with-sslmode-require>' \
  MARKLAB_REQUIRE_AUTH='true' \
  MARKLAB_PUBLIC_WEB_URL='https://<fly-app>.fly.dev' \
  MARKLAB_PUBLIC_API_URL='https://<fly-app>.fly.dev' \
  MARKLAB_PUBLIC_RELAY_WS_URL='wss://<fly-app>.fly.dev/relay' \
  MARKLAB_ALLOWED_ORIGINS='https://<fly-app>.fly.dev' \
  MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS='86400' \
  MARKLAB_RELAY_HOST_LEASE_SECONDS='30' \
  MARKLAB_RELAY_MAX_ROOM_CONNECTIONS='32' \
  MARKLAB_RELAY_MAX_MESSAGE_BYTES='1048576' \
  MARKLAB_YSWEET_PUBLIC_URL_PREFIX='https://<fly-app>.fly.dev' \
  MARKLAB_YSWEET_AUTH='<private_key-from-y-sweet-gen-auth>' \
  MARKLAB_YSWEET_SERVER_TOKEN='<server_token-from-y-sweet-gen-auth>'
```

`DATABASE_URL` must include `sslmode=require`. Public URL mismatch is a release blocker because share links, API calls, relay websocket joins, and Y-Sweet client token websocket URLs must resolve to the same deployed host unless a later custom-domain plan changes all of them together.

Provider env defaults that are not secrets live in `fly.toml`: `MARKLAB_YSWEET_PROVIDER_MODE=process`, `MARKLAB_YSWEET_SERVER_URL=http://127.0.0.1:8080`, `MARKLAB_YSWEET_STORE_PATH=/data/ysweet`, `MARKLAB_YSWEET_HOST=127.0.0.1`, `MARKLAB_YSWEET_PORT=8080`, `MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS=10`, and `MARKLAB_YSWEET_SKIP_GC=false`. Keep `MARKLAB_YSWEET_SKIP_GC=false` while MarkLab pins Y-Sweet 0.9.1; true is rejected because that server version has no `--skip-gc` serve flag.

## 6. Deploy

```bash
fly deploy
```

Then inspect:

```bash
fly status
fly logs
curl https://<fly-app>.fly.dev/healthz
```

For the default app:

```bash
curl https://marklab-relay-alpha.fly.dev/healthz
```

## 7. Schema And Health Expectations

The local production-smoke compose file applies `apps/api/src/db/schema.sql` before API health checks. Fly production should do the same through the migration path owned by the API integration work. Until the API exposes a source-integrated migration command, the operator must apply the checked-in schema to Neon before accepting alpha traffic.

`/healthz` reports process liveness separately from database readiness, schema readiness, relay readiness, and provider readiness. A production response is not alpha-ready unless `ok`, `database.ready`, `schema.ready`, `relay.ready`, `provider.ready`, and `provider.storeReady` are all `true`.

## 8. Release Gate

Before an alpha user tries the relay:

```bash
curl https://<fly-app>.fly.dev/healthz
fly status
fly logs
npx -y pnpm@10.0.0 --filter @marklab/api exec tsx src/provider/ysweet-provider-smoke.ts
```

Then run the product smoke:

```bash
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md
npx -y @marklab/cli join <edit-link> --dir ./docs --name README.md
```

The hosted relay is metadata, identity, permissions, and websocket routing only. It is not a cloud document workspace.
