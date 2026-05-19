# New Relay/Y-Sweet Pilot Runbook

This runbook is for the new MarkLab app path:

- Browser entry: `/collab?docId=...&branchId=...&mode=edit|view`
- Control plane: `/api/auth/*`, `/api/workspaces/*`, `/api/docs/*`, `/api/docs/:docId/branches/:branchId/collab/session`
- Provider: API-root Y-Sweet routes such as `/d/<providerDocId>/ws/<providerDocId>`
- Native app: MarkLab.app embeds `/collab` with `clientKind=app` and same-origin native bearer injection

It is not the old host-gated `/local#token=...` daemon route. The legacy local daemon bridge is disabled by default and only runs when `MARKLAB_APP_ENABLE_LOCAL_DAEMON_BOUNDARY=1` is explicitly set. The old local-daemon CLI command surface is also disabled by default and requires `MARKLAB_ENABLE_LEGACY_CLI=1` for archived compatibility testing.

## Can We Use The Current Fly.io + Neon Alpha?

Yes, Fly.io + Neon is the right pilot stack for the new relay/Y-Sweet app path after redeploying the new stack and applying the current schema. A healthy production pilot target must include:

- Latest API build with `createAuthRoutes`, workspace routes, access grants, collab-session routes, and provider proxy routes.
- Built `apps/collab-web/dist` mounted through `MARKLAB_COLLAB_WEB_DIST_DIR`.
- Neon schema applied from `apps/api/src/db/schema.sql`.
- `MARKLAB_REQUIRE_AUTH=true`.
- A real login path, normally OIDC env vars, because `NODE_ENV=production` disables `/api/auth/dev-login`.
- Y-Sweet process mode:
  - `MARKLAB_YSWEET_PROVIDER_MODE=process`
  - `MARKLAB_YSWEET_PUBLIC_URL_PREFIX=https://<fly-app>.fly.dev`
  - `MARKLAB_YSWEET_STORE_PATH=/data/ysweet`
  - `MARKLAB_YSWEET_AUTH=<private key from y-sweet gen-auth>`
  - `MARKLAB_YSWEET_SERVER_TOKEN=<server token from y-sweet gen-auth>`
- A Fly volume mounted at `/data/ysweet`.
- `/healthz` must return `ok: true` and include `provider.ready: true` plus `provider.storeReady: true`.

Production auth caveat: `/api/auth/dev-login` is disabled under `NODE_ENV=production`, even if `MARKLAB_ENABLE_DEV_AUTH=true` is set. For a broad external pilot, configure OIDC (`MARKLAB_OIDC_*`) or another real login path. For a small operator-run pilot before OIDC is wired, seed a pilot owner session directly through the deployed app code and store the resulting env in an ignored local file such as `.env.marklab-pilot`.

Production readiness checks:

```bash
curl -fsS https://marklab-relay-alpha.fly.dev/healthz | jq .
fly status -a marklab-relay-alpha
fly checks list -a marklab-relay-alpha
fly volumes list -a marklab-relay-alpha
fly secrets list -a marklab-relay-alpha
```

Required production signal:

```json
{
  "ok": true,
  "schema": {
    "ready": true,
    "missing": []
  },
  "provider": {
    "required": true,
    "ready": true,
    "storeReady": true
  }
}
```

If `fly deploy` hangs at `Waiting for depot builder` or `Waiting for remote builder`, use the documented Fly fallback:

```bash
open -a Docker
NO_COLOR=1 fly deploy -a marklab-relay-alpha --local-only --depot=false --wait-timeout 10m --yes
```

If `/healthz` reports missing schema objects after deploy, apply `apps/api/src/db/schema.sql` to the Neon database, then re-check `/healthz`. Do not proceed with manual acceptance until schema and provider are both ready.

## Local Pilot Setup

Use this for same-machine manual acceptance before production redeploy.

1. Create or choose a local/Postgres database:

```bash
createdb marklab_new_relay_pilot
psql "postgres://postgres:postgres@127.0.0.1:5432/marklab_new_relay_pilot" \
  -v ON_ERROR_STOP=1 \
  -f apps/api/src/db/schema.sql
```

2. Build the browser collaborator app:

```bash
npx -y pnpm@10.0.0 --filter @marklab/collab-web build
```

3. Generate Y-Sweet auth:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api exec y-sweet gen-auth --json
```

4. Start the local API/control-plane/provider stack. Substitute the generated auth values:

```bash
mkdir -p .marklab-provider-data/pilot-ysweet

DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/marklab_new_relay_pilot" \
PORT=3181 \
MARKLAB_HOST=127.0.0.1 \
MARKLAB_REQUIRE_AUTH=true \
MARKLAB_ENABLE_DEV_AUTH=true \
MARKLAB_PUBLIC_WEB_URL=http://127.0.0.1:3181 \
MARKLAB_PUBLIC_API_URL=http://127.0.0.1:3181 \
MARKLAB_PUBLIC_RELAY_WS_URL=ws://127.0.0.1:3181/relay \
MARKLAB_ALLOWED_ORIGINS=http://127.0.0.1:3181 \
MARKLAB_YSWEET_PROVIDER_MODE=process \
MARKLAB_YSWEET_SERVER_URL=http://127.0.0.1:3182 \
MARKLAB_YSWEET_PUBLIC_URL_PREFIX=http://127.0.0.1:3181 \
MARKLAB_YSWEET_STORE_PATH=.marklab-provider-data/pilot-ysweet \
MARKLAB_YSWEET_AUTH="<private_key>" \
MARKLAB_YSWEET_SERVER_TOKEN="<server_token>" \
MARKLAB_YSWEET_PORT=3182 \
MARKLAB_COLLAB_WEB_DIST_DIR="$PWD/apps/collab-web/dist" \
npx -y pnpm@10.0.0 --filter @marklab/api start
```

5. Confirm readiness:

```bash
curl -fsS http://127.0.0.1:3181/healthz | jq .
```

Required local signal:

```json
{
  "ok": true,
  "provider": {
    "required": true,
    "ready": true,
    "storeReady": true
  }
}
```

6. Seed a pilot workspace/document/link set:

```bash
API=http://127.0.0.1:3181

SESSION=$(curl -fsS -X POST "$API/api/auth/dev-login" \
  -H 'content-type: application/json' \
  --data '{"email":"pilot-owner@example.com","name":"Pilot Owner"}')
USER_TOKEN=$(printf '%s' "$SESSION" | jq -r .token)

WORKSPACE=$(curl -fsS -X POST "$API/api/workspaces" \
  -H "authorization: Bearer $USER_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"name":"New Relay Pilot"}')
WORKSPACE_ID=$(printf '%s' "$WORKSPACE" | jq -r .workspace.workspaceId)

# Local pilot only: give this workspace enough concurrent guest edit seats for
# browser-browser-app manual testing without stale sessions exhausting the free quota.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "update subscriptions set plan_id = 'dev', status = 'manual', current_period_end = null where workspace_id = '$WORKSPACE_ID'::uuid"

DOC=$(curl -fsS -X POST "$API/api/docs/import" \
  -H "authorization: Bearer $USER_TOKEN" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg workspaceId "$WORKSPACE_ID" \
    '{title:"pilot.md", markdown:"# New relay pilot\n\nStart here.\n", workspaceId:$workspaceId}')")
DOC_ID=$(printf '%s' "$DOC" | jq -r .docId)
BRANCH_ID=$(printf '%s' "$DOC" | jq -r .branchId)

EDIT_GRANT=$(curl -fsS -X POST "$API/api/docs/$DOC_ID/branches/$BRANCH_ID/access-grants" \
  -H "authorization: Bearer $USER_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"role":"edit"}')
VIEW_GRANT=$(curl -fsS -X POST "$API/api/docs/$DOC_ID/branches/$BRANCH_ID/access-grants" \
  -H "authorization: Bearer $USER_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"role":"view"}')

EDIT_TOKEN=$(printf '%s' "$EDIT_GRANT" | jq -r .token)
VIEW_TOKEN=$(printf '%s' "$VIEW_GRANT" | jq -r .token)

echo "Browser edit: $API/collab?docId=$DOC_ID&branchId=$BRANCH_ID&token=$EDIT_TOKEN&mode=edit"
echo "Browser view: $API/collab?docId=$DOC_ID&branchId=$BRANCH_ID&token=$VIEW_TOKEN&mode=view"
echo "Native env:"
echo "  MARKLAB_CONTROL_PLANE_API_URL=$API"
echo "  MARKLAB_PUBLIC_WEB_URL=$API"
echo "  MARKLAB_USER_TOKEN=$USER_TOKEN"
echo "  MARKLAB_WORKSPACE_ID=$WORKSPACE_ID"
```

## Manual Acceptance Pass

The full operator-driven test script lives in
[`pilot-acceptance-checklist.md`](./pilot-acceptance-checklist.md).

That checklist organizes the spec's testing criteria into a 90-minute
phased pass (smoke → convergence + presence → permissions + lifecycle
→ edge cases → native polish) with explicit step-by-step repros,
pass/fail signatures for each row, a bug-entry template for `bug.md`,
and escape hatches when a phase is blocked. Run it before inviting
pilot users and after any deploy that touches the API, collab-web,
native shell, or schema.

This runbook (above) is the setup half; the checklist is the execution
half. Read both before starting.

For quick reference, the spec criteria the checklist covers:

| Spec criterion | Checklist row |
| --- | --- |
| Browser-browser convergence | Phase 2.1 |
| App-browser convergence | Phase 2.2 |
| Guest editing while host app offline | Phase 4.1 |
| Host reconnect picks up guest changes | Phase 4.1 |
| Cursor 3-way | Phase 2.3 |
| Selection anchors after inserts | Phase 2.3 |
| Cursor disappears on disconnect | Phase 2.4 |
| View link cannot write | Phase 1.2 |
| Revoked edit link unavailable within TTL | Phase 3.2 |
| Provider token refresh transparent | Phase 3.1 |
| Missing local file pauses | Phase 4.3 |
| Disk + provider both diverge | Phase 4.4 |

The old `/local#token=...` path is not part of this pilot acceptance pass.
