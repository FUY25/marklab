# Fly.io And Neon Alpha Setup

This is the operator path for the current MarkLab alpha: hosted control plane, `/collab` browser app, and API-supervised Y-Sweet provider. It is not the archived anonymous daemon alpha.

## Target Regions

- Fly.io region: Singapore, `sin`
- Neon region: AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`

Keep Fly and Neon in Singapore for the alpha. Moving one without the other increases latency for control-plane metadata, access checks, and provider token issuance.

## 1. Create Accounts

Create or confirm access to:

- a Fly.io account;
- a Neon account;
- a Neon project in AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`.

The default Fly app name is `marklab-relay-alpha`. Use it unless Fly reports the name is unavailable. If you choose another app name, replace every URL and every `<fly-app>` placeholder in this document with the chosen name.

The Fly image serves the API, built `/collab` app, workspace settings shell, and API-root Y-Sweet provider proxy from the same Fly hostname. Browser/app collaborator links use `/collab?docId=...&branchId=...&token=...&mode=edit|view`; do not deploy an API-only image for the alpha.

The API co-locates the upstream Y-Sweet provider in the same Fly machine. The API supervises a child `y-sweet serve` process on `127.0.0.1:8080`, stores provider checkpoints on a Fly volume at `/data/ysweet`, and proxies public Y-Sweet document routes to that child process. Current Y-Sweet 0.9.1 client tokens use `/d/<providerDocId>/ws/<providerDocId>` for websocket sync plus `/d/<providerDocId>/as-update` and `/d/<providerDocId>/update` for token-scoped document HTTP traffic.

The current alpha is login/workspace backed. MarkLab.app creates or imports workspace-owned documents, creates access grants for collaborators, and receives short-lived provider tokens through the control plane. The old anonymous daemon route is no longer part of the pilot stack.

Run the private alpha as one Fly machine:

```bash
fly scale count 1 -a marklab-relay-alpha --yes
```

Provider websocket sessions and the co-located provider volume are single-machine assumptions for the private alpha. Scaling to multiple machines requires a later sticky-routing or shared provider fanout change.

## 2. Install And Authenticate Fly CLI

```bash
brew install flyctl
fly auth login
```

If Homebrew is not available, install Fly CLI with Fly's shell installer. Homebrew is only an operator dependency here; MarkLab is not documented as a Homebrew-distributed app for this alpha.

## 3. Create The Neon Database

In Neon:

1. Create a project such as `marklab-alpha`.
2. Select AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`.
3. Keep the default database and role, or create a dedicated `marklab` database and `marklab_app` role.
4. Copy the connection string.
5. Confirm the connection string includes `sslmode=require`.

Use the direct Neon connection string as `DATABASE_URL` for the private alpha. Do not commit it.

## 4. Create The Fly App

From the repository root:

```bash
fly launch --no-deploy --name marklab-relay-alpha --region sin
```

If `marklab-relay-alpha` is unavailable:

```bash
fly launch --no-deploy --name <fly-app> --region sin
```

If Fly generates a local `fly.toml`, compare it against the repo-root `fly.toml`. Checked-in Fly config must contain no secrets.

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
  MARKLAB_ALLOWED_ORIGINS='https://marklab-relay-alpha.fly.dev' \
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
  MARKLAB_ALLOWED_ORIGINS='https://<fly-app>.fly.dev' \
  MARKLAB_YSWEET_PUBLIC_URL_PREFIX='https://<fly-app>.fly.dev' \
  MARKLAB_YSWEET_AUTH='<private_key-from-y-sweet-gen-auth>' \
  MARKLAB_YSWEET_SERVER_TOKEN='<server_token-from-y-sweet-gen-auth>'
```

`DATABASE_URL` must include `sslmode=require`. Public URL mismatch is a release blocker because share links, API calls, and Y-Sweet client token websocket URLs must resolve to the same deployed host unless a later custom-domain plan changes all of them together.

Provider env defaults that are not secrets live in `fly.toml`: `MARKLAB_YSWEET_PROVIDER_MODE=process`, `MARKLAB_YSWEET_SERVER_URL=http://127.0.0.1:8080`, `MARKLAB_YSWEET_STORE_PATH=/data/ysweet`, `MARKLAB_YSWEET_HOST=127.0.0.1`, `MARKLAB_YSWEET_PORT=8080`, `MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS=10`, and `MARKLAB_YSWEET_SKIP_GC=false`. Keep `MARKLAB_YSWEET_SKIP_GC=false` while MarkLab pins Y-Sweet 0.9.1; true is rejected because that server version has no `--skip-gc` serve flag.

## 6. Deploy

Apply the checked-in schema to Neon before the health-gated deploy. `/healthz` includes schema readiness, so deploying first can leave the Fly rollout unhealthy until the schema catches up.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/src/db/schema.sql
```

```bash
fly deploy -a <fly-app> --local-only --depot=false --wait-timeout 10m --yes
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

The local production-smoke compose file applies `apps/api/src/db/schema.sql` before API health checks. Fly production must do the same before rollout. Until the API exposes a source-integrated migration command, the operator applies the checked-in schema to Neon directly.

`/healthz` reports process liveness separately from database readiness, schema readiness, and provider readiness. A release-ready response has `ok`, `database.ready`, `schema.ready`, `provider.ready`, and `provider.storeReady`.

## 8. Release Gate

Before an alpha user tries hosted collaboration:

```bash
curl https://<fly-app>.fly.dev/healthz
fly status
fly logs
npx -y pnpm@10.0.0 --filter @marklab/api exec tsx src/provider/ysweet-provider-smoke.ts
```

Then run the deployed product smoke. Always set the target URL explicitly, especially for staging or a non-default Fly app:

```bash
MARKLAB_ALPHA_BASE_URL=https://<fly-app>.fly.dev node scripts/marklab-alpha-smoke.mjs
MARKLAB_ALPHA_BASE_URL=https://<fly-app>.fly.dev MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 MARKLAB_USER_TOKEN=<ml_user_...> MARKLAB_WORKSPACE_ID=<workspace-id> node scripts/marklab-alpha-smoke.mjs
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser
marklab doctor --json
marklab open README.md
marklab share README.md
marklab join '<edit-link>'
```

The provider smoke and native/browser smoke above are local harnesses. They do not replace the deployed persistence check: create a real shared document on the Fly origin, type a marker, restart the Fly machine, and confirm the marker survives provider restart from `/data/ysweet`.

The hosted service is identity, permissions, document metadata, `/collab`, and provider routing. The user's local `.md` remains the native app working copy.
