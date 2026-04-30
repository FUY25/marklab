# Deployment Hardening and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MVP deployable and operable beyond a local demo.

**Architecture:** Extend Plan 8's basic Docker/API work with web build configuration, database migration execution, CORS/origin controls, health/readiness checks, smoke tests, backup guidance, and a short runbook. Keep the realtime backend as a persistent Node process.

**Tech Stack:** Node.js 22, Postgres, Docker, Vite, Express, Hocuspocus, Playwright, shell smoke scripts.

---

## Why This Plan Exists Here

Plan 8 creates a minimal API image and compose stack. A product launch also needs the web app to know API/WebSocket URLs, migrations to run deterministically, auth mode to be enabled, health checks to catch broken WebSocket/API/database wiring, and an operator runbook.

## File Structure

- Modify: `.env.example` - API, web, auth, CORS, WebSocket, and DB variables.
- Create: `Dockerfile.web` - web build image or static output image.
- Modify: `Dockerfile.api` - include migrations/schema execution support if missing.
- Modify: `docker-compose.yml` - include web, API, Postgres, auth, and health checks.
- Create: `scripts/apply-schema.mjs` - apply `apps/api/src/db/schema.sql`.
- Create: `scripts/smoke-mvp.mjs` - import/open/read/write/export smoke.
- Create: `docs/ops/runbook.md` - deployment and incident runbook.
- Test: `apps/api/src/config.test.ts`.

## Scope Check

This plan does not choose a paid hosting vendor. It makes the app deployable on a persistent Node host such as Fly.io, Railway, Render, DigitalOcean, or AWS. Cloudflare remains optional DNS/CDN/WAF.

## Task 1: Production config contract

**Files:**
- Modify: `.env.example`
- Modify: `apps/api/src/config.ts`
- Test: `apps/api/src/config.test.ts`

- [ ] **Step 1: Extend config**

Config must parse:

```text
DATABASE_URL
PORT
PUBLIC_WEB_URL
CORS_ORIGIN
MARKLAB_REQUIRE_AUTH
MARKLAB_ADMIN_TOKEN_HASH
MARKLAB_WS_PATH
```

`MARKLAB_REQUIRE_AUTH` defaults to `false` in local dev and must be set to `true` in production examples. `MARKLAB_ADMIN_TOKEN_HASH` is required when auth is enabled and full user accounts are not present.

- [ ] **Step 2: Update `.env.example`**

Include:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/marklab
PORT=3001
PUBLIC_WEB_URL=http://localhost:5175
CORS_ORIGIN=http://localhost:5175
MARKLAB_REQUIRE_AUTH=false
MARKLAB_ADMIN_TOKEN_HASH=
MARKLAB_WS_PATH=/
VITE_MARKLAB_API_URL=http://localhost:3001
VITE_MARKLAB_WS_URL=ws://localhost:3001/collab
```

- [ ] **Step 3: Run config tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/config.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .env.example apps/api/src/config.ts apps/api/src/config.test.ts
git commit -m "chore: define production config contract"
```

## Task 2: Schema migration command

**Files:**
- Create: `scripts/apply-schema.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add schema script**

Create `scripts/apply-schema.mjs` that:

```text
reads DATABASE_URL;
reads apps/api/src/db/schema.sql;
connects with pg;
runs the SQL once;
prints applied schema path and database host;
exits nonzero on error.
```

- [ ] **Step 2: Add package script**

Add root script:

```json
"db:apply-schema": "node scripts/apply-schema.mjs"
```

- [ ] **Step 3: Run schema command**

Run against the local test database:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 db:apply-schema
```

Expected: command prints successful schema application.

- [ ] **Step 4: Commit**

```bash
git add scripts/apply-schema.mjs package.json
git commit -m "chore: add schema apply command"
```

## Task 3: Web deployment artifact

**Files:**
- Create: `Dockerfile.web`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add web Dockerfile**

Create `Dockerfile.web` that builds `apps/web` with `VITE_MARKLAB_API_URL` and `VITE_MARKLAB_WS_URL` available at build time, then serves static output with a lightweight server.

- [ ] **Step 2: Update compose**

Compose must run:

```text
postgres
api
web
```

The web service must set:

```text
VITE_MARKLAB_API_URL=http://127.0.0.1:3001
VITE_MARKLAB_WS_URL=ws://127.0.0.1:3001/collab
```

- [ ] **Step 3: Build stack**

Run:

```bash
docker compose build
```

Expected: API and web images build.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.web docker-compose.yml
git commit -m "chore: add web deployment image"
```

## Task 4: Health, readiness, and smoke test

**Files:**
- Modify: `apps/api/src/http/app.ts`
- Create: `scripts/smoke-mvp.mjs`

- [ ] **Step 1: Add readiness route**

Add:

```http
GET /readyz
```

It must check database connectivity with `select 1` and return `503` if the database is unavailable.

- [ ] **Step 2: Add smoke script**

Create `scripts/smoke-mvp.mjs` that:

```text
creates/imports a document;
reads it;
performs edit_doc;
performs write_doc with fresh base;
lists versions;
branches from the first version;
exports Markdown;
prints docId, branchId, final version, and export filename.
```

The script should accept:

```text
MARKLAB_API_URL
MARKLAB_TOKEN
```

When `MARKLAB_TOKEN` is set, send `Authorization: Bearer <token>`.

- [ ] **Step 3: Run smoke locally**

Run:

```bash
MARKLAB_API_URL=http://127.0.0.1:3001 node scripts/smoke-mvp.mjs
```

Expected: script exits 0 and prints final version metadata.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/app.ts scripts/smoke-mvp.mjs
git commit -m "chore: add readiness and mvp smoke script"
```

## Task 5: Operations runbook

**Files:**
- Create: `docs/ops/runbook.md`

- [ ] **Step 1: Add runbook**

Create `docs/ops/runbook.md` with:

```text
Required environment variables.
How to apply schema.
How to start local compose.
How to run smoke test.
How to verify WebSocket connectivity.
How to enable MARKLAB_REQUIRE_AUTH.
How to generate and hash the controlled MVP admin token.
How to create the first agent token.
Backup expectation for Postgres.
Rollback expectation: restore previous app image plus database backup if schema changes are involved.
Known non-MVP exclusions: org RBAC, billing, GitHub sync, local file sync, MCP adapter, in-app AI diff UI.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ops/runbook.md
git commit -m "docs: add deployment runbook"
```

## Deployment Gate After This Plan

Before launch readiness signoff, these checks must be true:

```text
Production config is documented.
Schema can be applied deterministically.
API and web containers build.
Compose starts postgres, API, and web.
/healthz and /readyz pass.
Smoke script covers import/read/edit/write/version/branch/export.
Auth-required mode has been exercised.
Postgres backup expectations are documented.
```
