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

## 5. Set Runtime Secrets And Public URLs

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
  MARKLAB_RELAY_MAX_MESSAGE_BYTES='1048576'
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
  MARKLAB_RELAY_MAX_MESSAGE_BYTES='1048576'
```

`DATABASE_URL` must include `sslmode=require`. Public URL mismatch is a release blocker because share links, API calls, and relay websocket joins must resolve to the same deployed host unless a later custom-domain plan changes all three together.

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

`/healthz` reports process liveness separately from database readiness, schema readiness, and relay readiness. A production response is not alpha-ready unless `ok`, `database.ready`, `schema.ready`, and `relay.ready` are all `true`.

## 8. Release Gate

Before an alpha user tries the relay:

```bash
curl https://<fly-app>.fly.dev/healthz
fly status
fly logs
```

Then run the product smoke:

```bash
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md
npx -y @marklab/cli join <edit-link> --dir ./docs --name README.md
```

The hosted relay is metadata, identity, permissions, and websocket routing only. It is not a cloud document workspace.
