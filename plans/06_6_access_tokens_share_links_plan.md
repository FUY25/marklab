# Access Tokens and Share Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add basic MVP access control for browser share links and agent tokens before public deployment.

**Architecture:** Use the existing `agent_tokens` and `share_links` tables for document-scoped access, and use one admin/bootstrap token for controlled MVP creation and access management before full accounts exist. Store only token hashes, show raw document tokens once at creation, and gate REST/WebSocket access through shared verification helpers. Keep local development permissive unless `MARKLAB_REQUIRE_AUTH=true`.

**Tech Stack:** Express middleware, Postgres, Node crypto, Hocuspocus authentication hook, React, Playwright.

---

## Why This Plan Exists Here

The schema already includes agent tokens and share links, and the MVP scope includes basic share links and agent tokens. The implementation plans did not yet add token creation, revocation, route authorization, or WebSocket authorization. Plan 7's CLI token config is incomplete without a product way to issue an agent token.

Because full user accounts are out of MVP scope, production must not leave document creation and token management open to the public. The controlled MVP uses `MARKLAB_ADMIN_TOKEN_HASH` as a bootstrap credential for create/import and access-management routes. This can later be replaced by account auth without changing the document-scoped token model.

## File Structure

- Create: `apps/api/src/services/access-control.ts` - token generation, hashing, verification, permissions.
- Create: `apps/api/src/routes/access-routes.ts` - create/list/revoke agent tokens and share links.
- Modify: `apps/api/src/http/app.ts` - mount access routes and optional auth middleware.
- Modify: `apps/api/src/collab/server.ts` - verify Hocuspocus provider tokens when auth is required.
- Test: `apps/api/src/services/access-control.test.ts`.
- Test: `apps/api/src/routes/access-routes.test.ts`.
- Modify: `apps/web/src/lib/api-client.ts` - access route client methods and token passing.
- Create: `apps/web/src/lib/session-auth.ts` - session-scoped admin token storage for controlled MVP.
- Create: `apps/web/src/components/ShareAccessPanel.tsx` - create/copy/revoke tokens and links.
- Modify: `apps/web/src/pages/HomePage.tsx` - admin token entry when auth is required.
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx` - pass share token into Hocuspocus provider when present.
- Test: `apps/web/tests/access-ui.spec.ts`.

## Scope Check

This plan implements basic document-scoped access plus one deployment-level admin/bootstrap credential. It does not implement full user accounts, organizations, billing, SSO, complex RBAC, comments, or audit dashboards. Local dev can run unauthenticated, but production deployment must set `MARKLAB_REQUIRE_AUTH=true` and provide `MARKLAB_ADMIN_TOKEN_HASH`.

## Token Rules

- Agent token raw format: `ml_agent_` plus at least 32 random bytes encoded URL-safe.
- Share link token raw format: `ml_share_` plus at least 32 random bytes encoded URL-safe.
- Store `sha256Hex(rawToken)`, never the raw token.
- Return the raw token only in the create response.
- Revocation sets `revoked_at`, not hard delete.
- Expired or revoked tokens fail.
- Agent token permissions use `can_read` and `can_write`.
- Share links use `role='view'` or `role='edit'`.
- `write_doc`, `edit_doc`, create branch, restore, and Hocuspocus edit connection require write permission.
- `read_doc`, versions, and export require read permission.
- View-only share links must not mount the editable Hocuspocus editor. They should render read-only canonical Markdown from `read_doc` or a read-only preview component.
- `POST /api/docs`, `POST /api/docs/import`, and access-management routes require admin permission when `MARKLAB_REQUIRE_AUTH=true`.
- Admin token is configured by hash through `MARKLAB_ADMIN_TOKEN_HASH`; the raw admin token is never stored in the database.

## Task 1: Access-control service

**Files:**
- Create: `apps/api/src/services/access-control.ts`
- Test: `apps/api/src/services/access-control.test.ts`

- [ ] **Step 1: Write service tests**

Create tests that verify:

```text
generateAgentToken starts with ml_agent_.
generateShareToken starts with ml_share_.
hashToken never returns the raw token.
verifyAccess accepts a valid read token for read operations.
verifyAccess rejects revoked tokens.
verifyAccess rejects expired tokens.
verifyAccess rejects write operations when can_write=false.
verifyAdminToken accepts only a token whose hash matches MARKLAB_ADMIN_TOKEN_HASH.
```

- [ ] **Step 2: Implement service**

Create `apps/api/src/services/access-control.ts` with:

```ts
import { randomBytes } from 'node:crypto';
import type { DbPool } from '../db/client';
import { sha256Hex } from '@marklab/shared/src/hash';

export type AccessOperation = 'read' | 'write';

export function generateAgentToken(): string {
  return `ml_agent_${randomBytes(32).toString('base64url')}`;
}

export function generateShareToken(): string {
  return `ml_share_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function verifyAdminToken(token: string | undefined, adminTokenHash: string | undefined): void {
  if (!adminTokenHash) throw new Error('admin_token_not_configured');
  if (!token || hashToken(token) !== adminTokenHash) throw new Error('forbidden');
}

export async function verifyDocumentAccess(pool: DbPool, token: string, docId: string, branchId: string, operation: AccessOperation) {
  const tokenHash = hashToken(token);
  const agent = await pool.query(
    `select can_read, can_write, expires_at, revoked_at
       from agent_tokens
      where token_hash = $1 and doc_id = $2 and (branch_id = $3 or branch_id is null)`,
    [tokenHash, docId, branchId],
  );
  const share = await pool.query(
    `select role, expires_at, revoked_at
       from share_links
      where token_hash = $1 and doc_id = $2 and (branch_id = $3 or branch_id is null)`,
    [tokenHash, docId, branchId],
  );

  const now = Date.now();
  for (const row of agent.rows) {
    if (row.revoked_at) continue;
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) continue;
    if (operation === 'read' && row.can_read) return { actorType: 'agent' as const };
    if (operation === 'write' && row.can_write) return { actorType: 'agent' as const };
  }

  for (const row of share.rows) {
    if (row.revoked_at) continue;
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) continue;
    if (operation === 'read') return { actorType: 'user' as const };
    if (operation === 'write' && row.role === 'edit') return { actorType: 'user' as const };
  }

  throw new Error('forbidden');
}
```

- [ ] **Step 3: Run tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/access-control.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/access-control.ts apps/api/src/services/access-control.test.ts
git commit -m "feat: add document access token service"
```

## Task 2: Access routes

**Files:**
- Create: `apps/api/src/routes/access-routes.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/src/routes/access-routes.test.ts`

- [ ] **Step 1: Add access routes**

Create routes:

```http
POST   /api/docs/:docId/branches/:branchId/agent-tokens
GET    /api/docs/:docId/branches/:branchId/agent-tokens
DELETE /api/agent-tokens/:tokenId
POST   /api/docs/:docId/branches/:branchId/share-links
GET    /api/docs/:docId/branches/:branchId/share-links
DELETE /api/share-links/:linkId
```

Create response for agent token:

```json
{
  "tokenId": "uuid",
  "token": "ml_agent_...",
  "name": "Codex",
  "canRead": true,
  "canWrite": true,
  "expiresAt": null
}
```

List responses must not include raw `token`.

- [ ] **Step 2: Mount routes and errors**

Mount `createAccessRoutes(pool)` in `createHttpApp`. Return:

```text
403 forbidden
503 admin_token_not_configured
404 token_not_found
404 share_link_not_found
```

- [ ] **Step 3: Add route tests**

Test:

```text
create agent token returns raw token once.
list agent tokens omits raw token.
delete agent token revokes it.
create share link returns raw token once.
list share links omits raw token.
delete share link revokes it.
```

- [ ] **Step 4: Run route tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/access-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/access-routes.ts apps/api/src/routes/access-routes.test.ts apps/api/src/http/app.ts
git commit -m "feat: add access token routes"
```

## Task 3: Gate REST and WebSocket access

**Files:**
- Modify: `apps/api/src/http/app.ts`
- Modify: `apps/api/src/collab/server.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/doc-ai-routes.e2e.test.ts`
- Test: `apps/api/src/collab/server.test.ts`

- [ ] **Step 1: Add auth mode config**

Add config:

```text
MARKLAB_REQUIRE_AUTH=true|false
MARKLAB_ADMIN_TOKEN_HASH=sha256:...
```

When false or unset, current local tests remain unauthenticated. When true, protected routes require an `Authorization: Bearer <token>` header or a share token query parameter for browser routes. Create/import and access-management routes require the admin token.

- [ ] **Step 2: Add REST authorization**

For protected API routes:

```text
GET read/export/version routes require read.
POST write/edit/branch/restore routes require write.
POST create/import require admin token when auth is required.
POST/GET/DELETE access-management routes require admin token when auth is required.
```

Use the route `docId` and `branchId` when present. For version-specific routes, resolve the version's branch before checking access.

- [ ] **Step 3: Add Hocuspocus authorization**

Modify `createCollabServer(pool)` so Hocuspocus verifies provider token when `MARKLAB_REQUIRE_AUTH=true`. The provider token should be the share token or agent token passed by `createEditorCollab({ token })`.

- [ ] **Step 4: Add auth tests**

Test:

```text
read_doc without token returns 403 when auth required.
write_doc with read-only share link returns 403.
write_doc with can_write agent token is allowed.
create/import without admin token returns 403 when auth required.
access-management routes without admin token return 403 when auth required.
Hocuspocus rejects missing token when auth required.
Hocuspocus accepts edit share token for the target branch.
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/collab/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/app.ts apps/api/src/collab/server.ts apps/api/src/index.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/collab/server.test.ts
git commit -m "feat: gate document api and collab access"
```

## Task 4: Web share/access panel

**Files:**
- Modify: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/session-auth.ts`
- Modify: `apps/web/src/pages/HomePage.tsx`
- Create: `apps/web/src/components/ShareAccessPanel.tsx`
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx`

- [ ] **Step 1: Add client methods**

Add:

```ts
async createAgentToken(docId: string, branchId: string, input: { name: string; canWrite: boolean }): Promise<{ tokenId: string; token: string }>;
async listAgentTokens(docId: string, branchId: string): Promise<{ tokens: AgentTokenSummary[] }>;
async revokeAgentToken(tokenId: string): Promise<void>;
async createShareLink(docId: string, branchId: string, input: { role: 'view' | 'edit' }): Promise<{ linkId: string; token: string }>;
async listShareLinks(docId: string, branchId: string): Promise<{ links: ShareLinkSummary[] }>;
async revokeShareLink(linkId: string): Promise<void>;
```

- [ ] **Step 2: Add session admin token storage**

Create `apps/web/src/lib/session-auth.ts`:

```ts
const sessionAdminTokenKey = 'marklab.adminToken.v1';

export function readSessionAdminToken(storage: Storage = sessionStorage): string | null {
  return storage.getItem(sessionAdminTokenKey);
}

export function writeSessionAdminToken(token: string, storage: Storage = sessionStorage): void {
  storage.setItem(sessionAdminTokenKey, token);
}

export function clearSessionAdminToken(storage: Storage = sessionStorage): void {
  storage.removeItem(sessionAdminTokenKey);
}
```

Modify `MarklabWebApi` so create/import/access-management requests include `Authorization: Bearer <adminToken>` when a session admin token exists.

Also let document-scoped requests include a document token:

```ts
new MarklabWebApi({ adminToken, documentToken })
```

Use `documentToken` for read/export/version operations opened from a share URL. Use `adminToken` only for create/import and token-management operations.

- [ ] **Step 3: Add admin token entry**

Modify `HomePage` so controlled MVP users can enter an admin token for the current browser session before creating/importing documents. Store it only in `sessionStorage`, and provide a clear button.

- [ ] **Step 4: Add panel**

Create `ShareAccessPanel` with:

```text
Create agent token form with name and write permission checkbox.
Create share link form with view/edit role.
Raw token display after create, with copy button.
Existing tokens/links list with revoked state hidden and revoke button.
```

- [ ] **Step 5: Pass provider token**

Modify `RemoteDocumentPage` to read `?token=<share-or-agent-token>`.

Behavior:

```text
edit share token or write-capable agent token:
  pass token to createEditorCollab and mount editable Milkdown editor

view share token or read-only agent token:
  do not connect editable Hocuspocus provider
  call read_doc with Authorization: Bearer <token>
  render read-only canonical Markdown/preview with export and version read actions only
```

Do not persist document tokens to local storage.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/session-auth.ts apps/web/src/pages/HomePage.tsx apps/web/src/components/ShareAccessPanel.tsx apps/web/src/pages/RemoteDocumentPage.tsx
git commit -m "feat: add document share access ui"
```

## Task 5: Access E2E

**Files:**
- Create: `apps/web/tests/access-ui.spec.ts`

- [ ] **Step 1: Add browser access test**

Create a Playwright test that:

1. imports a document through the API;
2. opens the document page;
3. creates an edit share link through the UI;
4. opens the share URL in a new browser context with `?token=...`;
5. verifies the shared browser can edit and the owner browser sees it;
6. creates a view share link and verifies the shared browser does not mount an editable editor;
7. creates a read-only agent token;
8. verifies API `read_doc` succeeds with it and `write_doc` returns 403;
9. verifies create/import requires admin token when auth is required;
10. revokes the token and verifies `read_doc` returns 403 when auth is required.

- [ ] **Step 2: Run browser tests**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web test:e2e
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/access-ui.spec.ts
git commit -m "test: verify share links and agent tokens"
```

## Deployment Gate After This Plan

Before Plan 7 starts, these checks must be true:

```text
Agent tokens can be created, listed without raw secret, and revoked.
Share links can be created, listed without raw secret, and revoked.
Production auth mode rejects unauthenticated read/write/collab access.
Production auth mode rejects unauthenticated create/import/access-management.
Read-only tokens cannot write.
Write-capable tokens can use CLI/API write paths.
Admin/bootstrap token can create/import docs and manage share links or agent tokens.
Hocuspocus provider tokens map to the same doc/branch permission model as REST.
```
