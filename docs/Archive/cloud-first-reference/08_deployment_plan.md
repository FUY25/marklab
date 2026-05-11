# Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the Milkdown web app, Hocuspocus/WebSocket backend, and Postgres database for a working MVP.

**Architecture:** Use a persistent Node backend for API and WebSocket collaboration. Put frontend behind CDN/static hosting. Cloudflare can provide DNS/CDN but is not mandatory.

**Tech Stack:** Node.js 22, Postgres, Docker, Fly.io/Railway/Render, Cloudflare optional.

---

## File Structure

- Create: `Dockerfile.api` — API/WebSocket backend image.
- Create: `docker-compose.yml` — local Postgres + API + web development stack.
- Create: `.env.example` — required env vars.
- Create: `apps/api/src/config.ts` — validated environment config.
- Test: `apps/api/src/config.test.ts`.

## Scope Check

This plan deploys the core app. It does not include Cloudflare Durable Objects or GitHub sync.

### Task 1: Environment config

**Files:**
- Create: `apps/api/src/config.ts`
- Test: `apps/api/src/config.test.ts`
- Create: `.env.example`

- [ ] **Step 1: Write config test**

Create `apps/api/src/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';

describe('parseConfig', () => {
  it('parses valid config', () => {
    expect(parseConfig({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db', PORT: '3001' })).toEqual({
      databaseUrl: 'postgres://user:pass@localhost:5432/db',
      port: 3001,
    });
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => parseConfig({ PORT: '3001' })).toThrow('DATABASE_URL');
  });
});
```

- [ ] **Step 2: Implement config parser**

Create `apps/api/src/config.ts`:

```ts
import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgres://')).or(z.string().startsWith('postgresql://')),
  PORT: z.coerce.number().int().positive().default(3001),
});

export function parseConfig(env: Record<string, string | undefined>) {
  const parsed = configSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
  };
}
```

- [ ] **Step 3: Create env example**

Create `.env.example`:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/marklab
PORT=3001
```

- [ ] **Step 4: Run test**

Run:

```bash
pnpm test apps/api/src/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/config.test.ts .env.example
git commit -m "feat: add api environment config"
```

### Task 2: Dockerfile for API

**Files:**
- Create: `Dockerfile.api`

- [ ] **Step 1: Create API Dockerfile**

Create `Dockerfile.api`:

```dockerfile
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/markdown/package.json packages/markdown/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @marklab/api typecheck

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/apps/api /app/apps/api
COPY --from=build /app/packages /app/packages
COPY package.json pnpm-workspace.yaml ./
EXPOSE 3001
CMD ["pnpm", "--filter", "@marklab/api", "start"]
```

- [ ] **Step 2: Build image**

Run:

```bash
docker build -f Dockerfile.api -t marklab-api:local .
```

Expected: image builds successfully.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.api
git commit -m "chore: add api dockerfile"
```

### Task 3: Local compose stack

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create compose file**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: marklab
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/marklab
      PORT: 3001
    ports:
      - "3001:3001"
    depends_on:
      - postgres

volumes:
  pgdata:
```

- [ ] **Step 2: Start stack**

Run:

```bash
docker compose up --build
```

Expected: Postgres starts, API starts, `/healthz` returns `{"ok":true}`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add local docker compose stack"
```
