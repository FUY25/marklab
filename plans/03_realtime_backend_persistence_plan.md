# Realtime Backend and Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a persistent Hocuspocus backend that stores branch collaboration state as valid Yjs binary.

**Architecture:** Run Hocuspocus in a Node service. Store Yjs binary in Postgres and expose a separate REST API for read/write/edit/version operations. Canonical Markdown mirror refresh is not handled by raw Hocuspocus persistence alone; it is handled by the Milkdown serialization path in the editor/API plans.

> **Context note:** The original plan said this backend would "keep a canonical Markdown mirror" while the code only persisted `yjs_state`. That would make human edits durable in Yjs but stale for `read_doc`. The corrected plan narrows this backend to Yjs persistence and makes mirror refresh an explicit responsibility of the Milkdown serialization path.
>
> **2026-04-29 editor update:** The web editor is moving to Crepe for human editing, but this backend plan remains Yjs-persistence-only. Crepe UI plugins, CodeMirror code highlighting, TopBar, slash menus, and Yjs undo do not change the backend persistence contract. Do not attempt to derive canonical Markdown from Hocuspocus update hooks alone; Markdown serialization still belongs to a Milkdown-aware editor/live-writer path.

**Tech Stack:** Node.js 22, TypeScript, Express, Hocuspocus, Yjs, Postgres, Vitest, Supertest.

---

## File Structure

- Create: `apps/api/package.json` — API service dependencies.
- Create: `apps/api/tsconfig.json` — API service TypeScript config.
- Create: `apps/api/src/db/schema.sql` — initial database schema.
- Create: `apps/api/src/db/client.ts` — Postgres pool.
- Create: `apps/api/src/collab/server.ts` — Hocuspocus server setup.
- Create: `apps/api/src/collab/persistence.ts` — load/store Yjs binary state.
- Create: `apps/api/src/http/app.ts` — Express app.
- Create: `apps/api/src/index.ts` — process entrypoint.
- Test: `apps/api/src/collab/persistence.test.ts`.

## Scope Check

This plan produces a running realtime backend. AI write routes and versioning are separate plans.

### Task 1: API package setup

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`

- [ ] **Step 1: Create API package**

Create `apps/api/package.json`:

```json
{
  "name": "@marklab/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hocuspocus/server": "^4.0.0",
    "@marklab/shared": "workspace:*",
    "@marklab/markdown": "workspace:*",
    "express": "^5.0.0",
    "pg": "^8.13.0",
    "ws": "^8.18.0",
    "y-protocols": "^1.0.6",
    "yjs": "^13.6.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/pg": "^8.11.0",
    "@types/ws": "^8.5.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

> **Context note:** The original API dependency list used Hocuspocus `^3.0.0`, and the script tried to start a compiled `dist` entrypoint without defining a build step. As of the Milkdown/source review on 2026-04-29, Hocuspocus latest is `4.0.0`; the corrected plan uses the current major, declares the Yjs protocol peer explicitly, and starts the TypeScript entrypoint with `tsx` for the MVP.

- [ ] **Step 2: Create API TypeScript config**

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

> **Context note:** The original plan ran `pnpm --filter @marklab/api typecheck` but did not create an API `tsconfig.json`. This config makes the package script deterministic.

- [ ] **Step 3: Install dependencies**

Run:

```bash
pnpm install
```

Expected: dependency install completes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/package.json apps/api/tsconfig.json pnpm-lock.yaml
git commit -m "chore: add api service package"
```

### Task 2: Database schema

**Files:**
- Create: `apps/api/src/db/schema.sql`

- [ ] **Step 1: Create schema SQL**

Create `apps/api/src/db/schema.sql`:

```sql
create extension if not exists pgcrypto;

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  title text not null default 'Untitled',
  default_branch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists document_branches (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  name text not null,
  slug text not null,
  head_version_id uuid,
  created_from_version_id uuid,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (doc_id, slug)
);

alter table documents
  add constraint documents_default_branch_fk
  foreign key (default_branch_id)
  references document_branches(id)
  deferrable initially deferred;

create table if not exists document_branch_states (
  branch_id uuid primary key references document_branches(id) on delete cascade,
  yjs_state bytea not null,
  current_markdown text not null,
  current_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists document_versions (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid not null references document_branches(id) on delete cascade,
  parent_version_id uuid references document_versions(id),
  version_number integer not null,
  markdown_snapshot text not null,
  hash text not null,
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id text,
  operation text not null check (operation in ('create', 'import', 'autosave', 'manual_save', 'write', 'edit', 'rollback', 'branch')),
  created_at timestamptz not null default now(),
  unique (branch_id, version_number)
);

create table if not exists agent_tokens (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid references document_branches(id) on delete cascade,
  token_hash text not null,
  name text not null,
  can_read boolean not null default true,
  can_write boolean not null default false,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists share_links (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid references document_branches(id) on delete cascade,
  token_hash text not null,
  role text not null check (role in ('view', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
```

> **Context note:** The original implementation schema stopped at `document_versions`, even though the MVP scope and data model require basic agent tokens and share links. The corrected initial schema includes those tables so later auth/tooling plans have storage to build on.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/db/schema.sql
git commit -m "feat: add initial document database schema"
```

### Task 3: Postgres client

**Files:**
- Create: `apps/api/src/db/client.ts`

- [ ] **Step 1: Create DB client**

Create `apps/api/src/db/client.ts`:

```ts
import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString });
}

export type DbPool = ReturnType<typeof createPool>;
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/client.ts
git commit -m "feat: add postgres client factory"
```

### Task 4: Hocuspocus persistence adapter

**Files:**
- Create: `apps/api/src/collab/persistence.ts`
- Test: `apps/api/src/collab/persistence.test.ts`

- [ ] **Step 1: Write failing persistence test with fake pool**

Create `apps/api/src/collab/persistence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createEmptyYjsState, loadYjsState, parseRoomName } from './persistence';

describe('parseRoomName', () => {
  it('parses doc branch room', () => {
    expect(parseRoomName('doc:doc_abc:branch:br_main')).toEqual({ docId: 'doc_abc', branchId: 'br_main' });
  });

  it('rejects invalid room', () => {
    expect(() => parseRoomName('bad')).toThrow('invalid_room_name');
  });
});

describe('createEmptyYjsState', () => {
  it('returns a non-empty valid encoded update', () => {
    expect(createEmptyYjsState().byteLength).toBeGreaterThan(0);
  });
});

describe('loadYjsState', () => {
  it('treats legacy zero-length state as missing', async () => {
    const pool = {
      query: async () => ({ rows: [{ yjs_state: Buffer.alloc(0) }] }),
    };

    expect(await loadYjsState(pool as never, 'doc:doc_abc:branch:br_main')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test apps/api/src/collab/persistence.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement room parser and persistence skeleton**

Create `apps/api/src/collab/persistence.ts`:

```ts
import type { DbPool } from '../db/client';
import * as Y from 'yjs';

export interface ParsedRoomName {
  docId: string;
  branchId: string;
}

export function parseRoomName(roomName: string): ParsedRoomName {
  const match = /^doc:([^:]+):branch:([^:]+)$/.exec(roomName);
  if (!match) throw new Error('invalid_room_name');
  return { docId: match[1], branchId: match[2] };
}

export function createEmptyYjsState(): Uint8Array {
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export async function loadYjsState(pool: DbPool, roomName: string): Promise<Uint8Array | null> {
  const { branchId } = parseRoomName(roomName);
  const result = await pool.query('select yjs_state from document_branch_states where branch_id = $1', [branchId]);
  const row = result.rows[0] as { yjs_state?: Buffer } | undefined;
  if (!row?.yjs_state || row.yjs_state.byteLength === 0) return null;
  return new Uint8Array(row.yjs_state);
}

export async function storeYjsState(pool: DbPool, roomName: string, state: Uint8Array): Promise<void> {
  const { branchId } = parseRoomName(roomName);
  await pool.query(
    `update document_branch_states
       set yjs_state = $2, updated_at = now()
     where branch_id = $1`,
    [branchId, Buffer.from(state)],
  );
}
```

> **Context note:** The original downstream plans inserted an empty byte buffer for new branch state. Empty bytes are not a valid Yjs update. This helper gives import/branch code a valid encoded empty Y.Doc state, and `loadYjsState` treats any legacy zero-length value as missing before `Y.applyUpdate`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test apps/api/src/collab/persistence.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/collab/persistence.ts apps/api/src/collab/persistence.test.ts
git commit -m "feat: add yjs room persistence helpers"
```

### Task 5: Hocuspocus server setup

**Files:**
- Create: `apps/api/src/collab/server.ts`
- Create: `apps/api/src/http/app.ts`
- Create: `apps/api/src/index.ts`

- [ ] **Step 1: Create Hocuspocus server factory**

Create `apps/api/src/collab/server.ts`:

```ts
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { DbPool } from '../db/client';
import { loadYjsState, storeYjsState } from './persistence';

export function createCollabServer(pool: DbPool) {
  return Server.configure({
    name: 'marklab',
    async onLoadDocument(data) {
      const state = await loadYjsState(pool, data.documentName);
      if (!state) return new Y.Doc();
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      return doc;
    },
    async onStoreDocument(data) {
      const update = Y.encodeStateAsUpdate(data.document);
      await storeYjsState(pool, data.documentName, update);
    },
  });
}
```

> **Context note:** This hook deliberately stores only the Yjs binary state. The original wording implied this hook also refreshed `current_markdown`, but Hocuspocus receives a Y.Doc, not a Milkdown serializer. Canonical mirror refresh must be tested in the editor/API path that has access to Milkdown markdown serialization.

- [ ] **Step 2: Create HTTP app**

Create `apps/api/src/http/app.ts`:

```ts
import express from 'express';

export function createHttpApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 3: Create entrypoint**

Create `apps/api/src/index.ts`:

```ts
import http from 'node:http';
import { createPool } from './db/client';
import { createCollabServer } from './collab/server';
import { createHttpApp } from './http/app';

const port = Number(process.env.PORT ?? 3001);
const pool = createPool();
const app = createHttpApp();
const httpServer = http.createServer(app);
const collabServer = createCollabServer(pool);

httpServer.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/collab')) {
    socket.destroy();
    return;
  }
  collabServer.handleConnection(request, socket, head);
});

httpServer.listen(port, () => {
  console.log(`api listening on :${port}`);
});
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS against the installed Hocuspocus major. If the `handleConnection` API differs, update the code to the installed type signature and rerun typecheck; do not leave a cast-based workaround.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/collab/server.ts apps/api/src/http/app.ts apps/api/src/index.ts
git commit -m "feat: add hocuspocus realtime backend"
```
