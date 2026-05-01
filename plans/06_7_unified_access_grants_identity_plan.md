# Unified Access Links, Session Identity, and Remote Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace split share-link/agent-token UX with one branch-scoped access link, let each editable browser or agent name itself as a collaboration participant, support both manual and automatic document saves, and make the remote document screen feel like a clean editor instead of an admin dashboard.

**Architecture:** Use a single `access_grants` table for branch-scoped bearer access and a separate `access_sessions` table for the individual editable browsers or agents using that access. Keep the remote document canvas visually primary; move versions/save/export and sharing/access controls into two icon-triggered overlay drawers on the right side for owner/editable sessions. Read-only access renders a selectable, copyable document view for the shared branch only and never mounts editable Milkdown/Hocuspocus.

**Tech Stack:** Postgres schema, Express routes, Hocuspocus auth hook, React, Milkdown/Crepe, `lucide-react`, localStorage-backed browser identity, Playwright, Vitest.

---

## Product Decisions

- There is one shareable value: an access link.
- Access is branch-scoped. The branch in the URL is the branch that was shared, and the grant authorizes that branch only.
- View-only browser links and AI/read access can read only the shared current branch.
- Edit links are full branch-collaborator links for the shared current branch. They can edit the document, use the Versions drawer, and use the Share drawer for that branch.
- Edit links still cannot use the same token to access a different branch. If another branch should be shared, create a separate access link from that branch.
- The access grant does not need a user-entered label/name field.
- A grant has only permission metadata: `view` or `edit`, created time, revoked state, branch id, and token hash.
- A browser or agent session has the collaboration identity: display name, color, client id, kind, first seen, last seen.
- The sharer does not name the guest. The guest, collaborator, or AI names itself the first time it opens/uses the link.
- The document owner/admin also gets prompted for the name they want to show as in editable collaboration.
- Only editable collaboration prompts for a collaborator name. View-only links open immediately.
- Read-only browser/API use does not need an `access_sessions` row in Plan 6.7 unless the implementation wants lightweight last-used auditing. Collaboration identity is only required for editable presence.
- If a collaborator or agent leaves the name blank, the server assigns `Guest 1`, `Guest 2`, etc. for that access link.
- One access link can have many sessions: different browsers or agents should show as different collaborators.
- Revoking an access link revokes the grant for everyone using that link. It does not revoke one browser identity/session only.
- Per-session revoke is out of scope for Plan 6.7 because identity is intentionally decoupled from the shared access value.
- Cursor labels use session identity, not access-link metadata.
- Cursor labels should be small and attached to the cursor, with colored selection. Do not reintroduce the large filled "Human Writer" bar.
- The owner/editable persistent remote document screen should show the document/editor canvas and only two fixed icon buttons: Versions and Share.
- View-only access shows a rendered read-only document surface, with no Versions or Share buttons.
- Drawers overlay the document. Opening a drawer must not resize or shift the editor.
- Version control behavior is branch-shared. Manual save, autosave, and restore operate on the shared branch source, not on one collaborator's private session.
- Drawer UI state is per browser. Opening the Versions drawer, selecting a preview, or opening Share does not sync to other collaborators.
- Add `lucide-react` for recognizable icon-only actions.
- Plan 6.7 prepares browser/agent sessions and identity. Plan 7 handles API write attribution for AI edits.
- Prelaunch compatibility can break old product UI token names. New product UI should create `ml_access_` links only; existing legacy routes may remain for tests/migration.

## Permission Model

Plan 6.7 intentionally uses a small role model:

```text
owner/admin
  Full document admin through MARKLAB_ADMIN_TOKEN_HASH.
  Can create/import documents.
  Can access every branch.
  Can use Versions and Share drawers on every branch.

ml_access_ view grant
  Can read only the shared branch.
  Opens a clean rendered document view.
  No collaborator name prompt.
  No Hocuspocus connection.
  No Versions drawer.
  No Share drawer.

ml_access_ edit grant
  Full collaborator for the shared branch.
  Can edit the shared branch through Hocuspocus.
  Can use Versions drawer for current-branch state: save, autosave status, export, version list, version preview, and restore.
  Can use Share drawer for the shared branch.
  Can create and revoke access links for the shared branch.
  Cannot use the same token to access another branch.
  Cannot branch-switch or branch-from-version in Plan 6.7, because those actions leave the shared branch scope.
```

This is closer to Notion's `Full access` behavior than Notion's narrower `Can edit` behavior: editing and sharing are bundled for MarkLab branch collaborators.

## Shared Version Behavior

Version operations are branch-level collaboration events:

```text
Manual save:
  Creates a manual_save version from the freshly flushed live branch state.
  All collaborators remain on the same branch and can see the new version after refresh or live version-list update.

Autosave:
  Creates quiet autosave versions from the freshly flushed live branch state.
  All collaborators remain on the same branch.

Restore:
  Creates a rollback version from the selected version through LiveMarkdownWriter.
  Persists the returned non-empty encoded yjsState.
  Applies that yjsState to the active Hocuspocus/Y.Doc room when collaborators are connected.
  Connected collaborators receive the restored document state instead of continuing to edit stale in-memory content.

Drawer UI:
  Open/closed drawer state, selected version preview, and local errors are per-browser and do not sync.
```

Implementation rule for restore:

```ts
await options.flushCollabDocument?.(toRoomName(docId, branchId));
const applied = await restoreVersionToBranchState({ pool, liveWriter, docId, branchId, versionId });
await options.applyCollabDocumentState?.(toRoomName(docId, branchId), applied.yjsState);
```

Do not mark restore complete if it only updates Postgres. Active Hocuspocus state must be updated for currently connected collaborators.

## Notion-Informed Collaboration Pattern

Use Notion as a product reference, not as a strict clone:

- A single Share surface owns invite/access management, link copy, and permission level changes.
- Permission levels are simple and user-facing. MarkLab keeps only `View` and `Edit`; `Edit` behaves like full branch collaborator access.
- Anyone-with-link style access should be easy to create, easy to copy, and easy to revoke.
- View access is read-only and cannot share or edit.
- Presence identity is separate from the access grant. The link grants permission; the session/browser/agent supplies the visible collaborator name and color.
- Collaborator presence should be quiet: small cursor labels and colored selections, not a large block-level banner.
- AI access follows the same mental model as a connection/bot identity: the access link grants scope, while the agent identifies itself as a session when it participates in editable collaboration.

## Default Remote Document UI

The default owner/editable `/docs/:docId/branches/:branchId` screen should remove or hide these from the persistent page:

```text
Cloud document
MarkLab
full document id
top toolbar card
Documents button
Copy link
Export Markdown
branch selector
share/access panel
version history panel
raw API error text
```

The persistent screen should contain:

```text
[document/editor canvas]

                                      [Versions icon button]
                                      [Share icon button]
```

Small status is allowed, but it should be quiet: `Saved`, `Offline`, `Read only`, or `Unable to load document`, preferably bottom-right or inside an open drawer. It should not be the page headline.

Owner/editable pages should support manual save from the keyboard:

```text
Cmd+S on macOS -> manual Save version
Ctrl+S on Windows/Linux -> manual Save version
```

The browser's default save-page behavior should be prevented while focus is inside the editor page.

Show a small muted save status in the bottom-right corner of the page:

```text
Saving...
Saved 12:47 AM
Autosaved 12:52 AM
Manual saved 12:55 AM
Offline
Unable to save
```

The status should be visually quiet, grey, and not part of the page headline.

View-only access should be even quieter:

```text
[rendered document view]

small optional status: Read only
```

Rules:

- The rendered document must allow normal text selection and copy/paste into another app.
- The rendered document must not show raw Markdown as the primary view.
- The page must not show Versions, Share, branch switching, access management, or raw API errors.
- It must not create a Hocuspocus provider or mount the editable collab plugin.

## Drawer UX

Add a fixed right-side icon rail:

```text
position: fixed
right: 16px
top: 48px
display: grid
gap: 8px
```

Buttons:

```text
40x40 or 44x44
icon only
light gray background
subtle active state
tooltip and aria-label
no text inside the button
no large floating card behind them
```

Use `lucide-react`. Suggested icons:

```text
Versions: History, Clock3, or GitBranch
Share: Share2
Close: X
```

Only one drawer can be open at a time:

```text
Click Versions -> opens Versions drawer.
Click Share -> opens Share drawer.
Click active button -> closes drawer.
Escape -> closes drawer.
Click outside drawer -> closes drawer.
Narrow screens -> drawer is full-width or near full-width.
```

Drawer styling:

```text
position: fixed
right: 0
top: 0
height: 100vh
width: 340px to 380px
background: white or near-white
border-left: 1px solid soft border
box-shadow: subtle only if needed
z-index above editor
```

Inside drawers:

```text
one 48-56px header row
compact section labels
16px section padding
12px section gap
thin dividers
34-36px inputs
32-36px buttons
no nested cards
no all-caps except tiny muted section labels
one primary action per section
quiet text/outline destructive actions
readable errors instead of raw API JSON
```

## Versions Drawer

The Versions drawer owns document state:

```text
Versions                                      [x]

Current
main (v1)                         [branch select]

[Save version]                    [Export .md]

History
v1   import              May 1, 12:47 AM
v2   manual save         May 1, 12:55 AM

Preview
# selected version preview...

Advanced
[Branch from this version]
[Restore this version]

[Back to documents]
```

Rules:

- The system needs both automatic saves and manual saves.
- Manual `Save version` creates an explicit version checkpoint from the freshly flushed live branch state.
- Automatic save creates quiet background checkpoints from changed live branch state, with throttling/debounce so normal typing does not create a version for every keystroke.
- Both save paths must flush any active Hocuspocus in-memory Y.Doc before reading branch state.
- If the flushed live hash equals the latest saved version hash, manual save should return `created: false` instead of creating a duplicate version.
- `Cmd+S` / `Ctrl+S` triggers the same manual save path as the drawer's `Save version` button.
- Manual and automatic save results update the small bottom-right save status.
- Export Markdown moves here.
- Branch switching moves here and should be compact.
- Branch from version and restore are advanced actions.
- Restore should be quiet until chosen; do not make it a giant red block.
- Back to documents moves here as a quiet link/button.

Current control mapping:

```text
Documents -> Versions drawer, quiet Back to documents
Export Markdown -> Versions drawer
BranchSwitcher -> Versions drawer
VersionHistoryPanel -> Versions drawer
```

## Share Drawer

The Share drawer owns access:

```text
Share                                         [x]

Access link
[View] [Edit]
[Create link]

Created link
https://127.0.0.1:5173/...        [Copy]
[Copy AI prompt]

Active links
View link       May 1, 12:47 AM   Revoke
Edit link       May 1, 12:50 AM   Revoke

Recent sessions
Guest 1         browser           12:52 AM
Claude          agent             12:53 AM

My collaboration name
Alex                              [Change]
```

Rules:

- Do not show separate "browser link" and "raw token" values.
- Do not show a user-entered label/name field for the access link.
- The one-time created panel shows only the access link and copy actions.
- The raw token is embedded in that one-time access link and stored only as a hash.
- The access list does not expose raw tokens.
- "Copy AI prompt" should use the same access link.
- The prompt can be pre-Plan 7 text, but it must be role-aware.
- Until Plan 7, AI edit instructions are a placeholder around the same access link. Plan 6.7 must still enforce branch-scoped read/write permissions.
- The optional "My collaboration name" control appears only for editable owner/shared sessions, inside the Share drawer.
- There is no collaborator-name chip or label-name field on the persistent page.
- All edit grants and owner/admin sessions can open this Share drawer for the current branch.
- Revoking a link asks for confirmation using plain language: `Revoke this link for everyone using it?`
- The active links list hides revoked links by default. Revoked grants remain in the database for audit/debugging and may be exposed later behind an `includeRevoked=true` admin query.
- Revoking a link must block REST access immediately and block new Hocuspocus connections. If immediate disconnection of already-connected Hocuspocus clients cannot be implemented cleanly in this plan, document that as a blocker before marking the gate complete.

AI prompt text for view links:

```text
You have view-only access to the shared branch of this MarkLab document.

Open this access link:
<access link>

You may read, quote, summarize, and explain the shared branch. Do not attempt to edit it or switch branches.
```

AI prompt text for edit links:

```text
You have edit access to the shared branch of this MarkLab document.

Open this access link:
<access link>

When MarkLab asks for your collaborator name, identify yourself clearly. You may read and edit the shared branch through MarkLab. Preserve document structure and avoid unrelated changes.
```

Current control mapping:

```text
Copy link -> Share drawer
ShareAccessPanel -> Share drawer
Agent-token UI -> removed from default UX and replaced by the same access-link model
```

## Data Model

Add unified access grants:

```sql
create table if not exists access_grants (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid not null references document_branches(id) on delete cascade,
  token_hash text not null unique,
  role text not null check (role in ('view', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
```

Add per-browser/per-agent sessions:

```sql
create table if not exists access_sessions (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references access_grants(id) on delete cascade,
  client_id text not null,
  client_kind text not null default 'browser' check (client_kind in ('browser', 'agent', 'api')),
  display_name text not null,
  color text not null,
  last_branch_id uuid references document_branches(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (grant_id, client_id)
);

create index if not exists access_grants_doc_active_idx
  on access_grants (doc_id, branch_id, created_at desc)
  where revoked_at is null;

create index if not exists access_sessions_grant_seen_idx
  on access_sessions (grant_id, last_seen_at desc);
```

Existing `agent_tokens` and `share_links` can remain in the schema for local compatibility, but new UI and new access routes should use `access_grants`.

Schema rules:

- `access_grants.branch_id` is both the landing branch and the access scope.
- The verifier must reject a grant if the requested `branchId` differs from `access_grants.branch_id`, even when the document id matches.
- The verifier must also confirm that `branch_id` belongs to `doc_id`.
- Do not store raw `ml_access_` tokens. Store only token hashes.
- Guest display-name assignment must be race-safe. Assign `Guest N` inside a transaction with the relevant grant/session rows locked, or use a uniqueness constraint plus retry if display names become unique per grant.
- Revocation uses `revoked_at`, not deletion, so historical sessions can remain attached to the grant.

## API Shape

Create/list/revoke access links:

```http
POST   /api/docs/:docId/branches/:branchId/access-grants
GET    /api/docs/:docId/branches/:branchId/access-grants
DELETE /api/access-grants/:grantId
```

Create request:

```json
{
  "role": "edit",
  "expiresAt": null
}
```

Create response:

```json
{
  "grantId": "uuid",
  "role": "edit",
  "branchId": "current-branch-id",
  "token": "ml_access_...",
  "createdAt": "2026-05-01T00:00:00.000Z"
}
```

List response:

```json
{
  "grants": [
    {
      "grantId": "uuid",
      "role": "edit",
      "branchId": "branch-id",
      "branchName": "main",
      "expiresAt": null,
      "revokedAt": null,
      "createdAt": "2026-05-01T00:00:00.000Z",
      "sessions": [
        {
          "sessionId": "uuid",
          "clientKind": "browser",
          "displayName": "Guest 1",
          "color": "#3b82f6",
          "lastBranchId": "branch-id",
          "lastSeenAt": "2026-05-01T00:02:00.000Z"
        }
      ]
    }
  ]
}
```

Create/update a session:

```http
POST /api/docs/:docId/branches/:branchId/access-sessions
Authorization: Bearer ml_access_...
```

Request:

```json
{
  "clientId": "browser-generated-stable-id",
  "clientKind": "browser",
  "displayName": "Alex"
}
```

Response:

```json
{
  "grantId": "uuid",
  "sessionId": "uuid",
  "displayName": "Alex",
  "color": "#3b82f6",
  "role": "edit",
  "canRead": true,
  "canWrite": true
}
```

Access introspection keeps the existing route:

```http
GET /api/docs/:docId/branches/:branchId/access
Authorization: Bearer ml_access_...
```

Response:

```json
{
  "canRead": true,
  "canWrite": true,
  "canManageAccess": true,
  "canManageVersions": true,
  "canSwitchBranches": false,
  "actorType": "user",
  "grantId": "uuid",
  "role": "edit"
}
```

Branch-scoped metadata route:

```http
GET /api/docs/:docId/branches/:branchId/summary
Authorization: Bearer ml_access_...
```

Response:

```json
{
  "docId": "uuid",
  "branchId": "uuid",
  "title": "Document title",
  "branchName": "main",
  "branchSlug": "main",
  "access": {
    "canRead": true,
    "canWrite": true,
    "canManageAccess": true,
    "canManageVersions": true,
    "canSwitchBranches": false,
    "role": "edit"
  }
}
```

Rules:

- Shared-link pages should use the branch-scoped summary route instead of requiring `/api/docs/:docId` or `/api/docs/:docId/branches`.
- Owner/admin pages may still load the full document summary and branch list.
- Branch-scoped tokens must not be required to read the default branch just to render a non-default shared branch.
- Branch-scoped tokens must not receive a full branch list unless the product intentionally adds cross-branch access later.

Admin/bootstrap token behavior from Plan 6.6 remains supported.

## File Structure

- Modify: `apps/api/src/db/schema.sql` - add `access_grants` and `access_sessions`.
- Modify: `apps/api/src/services/access-control.ts` - add `ml_access_` tokens, branch-scoped grant verification, and session identity helpers.
- Modify: `apps/api/src/routes/access-routes.ts` - add unified grant/session routes and retire split share/agent creation from the active path.
- Modify: `apps/api/src/http/app.ts` - keep REST auth using the unified verifier.
- Modify: `apps/api/src/collab/server.ts` - gate Hocuspocus edit connections through unified grants.
- Modify: `apps/api/src/routes/version-routes.ts` - add branch-scoped summary behavior and expose manual save if the route is not already present.
- Modify: `apps/api/src/services/milkdown-transformer.ts` and `apps/api/src/services/save-policy.ts` only if the existing checkpoint helpers need small extensions.
- Test: `apps/api/src/services/access-control.test.ts`.
- Test: `apps/api/src/routes/access-routes.test.ts`.
- Test: `apps/api/src/services/version-service.test.ts`.
- Test: `apps/api/src/routes/version-routes.test.ts`.
- Test: `apps/api/src/collab/server.test.ts`.
- Modify: `apps/web/package.json` - add `lucide-react`.
- Modify: `apps/web/src/lib/api-client.ts` - replace share/agent methods with access grant/session methods.
- Create: `apps/web/src/lib/access-session.ts` - local browser client id and collaborator-name storage.
- Create: `apps/web/src/components/DocumentActionRail.tsx` - fixed right-side Versions/Share icon buttons.
- Create: `apps/web/src/components/DocumentDrawer.tsx` - shared overlay drawer shell.
- Create or modify: `apps/web/src/components/VersionsDrawer.tsx` - branch, versions, export, branch/restore, back navigation.
- Create or modify: `apps/web/src/components/ShareDrawer.tsx` - unified access-link creation/listing, AI prompt copy, sessions.
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx` - clean default canvas, drawer state, session identity prompts, read-only behavior.
- Modify: `apps/web/src/components/MilkdownEditor.tsx` - small cursor label rendering.
- Modify: `apps/web/src/lib/editor-collab.ts` - use session identity in awareness.
- Modify: `apps/web/src/styles.css` - clean canvas, icon rail, drawers, cursor labels.
- Test: `apps/web/tests/access-ui.spec.ts`.
- Test: `apps/web/tests/version-branch-ui.spec.ts`.
- Test: `apps/web/tests/document-lifecycle.spec.ts`.
- Test: `apps/web/tests/remote-document.spec.ts`.

## Sequencing Gates

Do not start the next stage until the current gate passes or the blocker is written down with exact failing commands.

```text
Gate 1: Unified branch-scoped access backend passes access-control and access-routes tests.
Gate 2: REST and Hocuspocus authorization pass doc-ai and collab tests.
Gate 3: Manual and automatic save checkpoints pass version/editor-state tests.
Gate 4: Web session identity passes access and remote-document E2E tests.
Gate 5: Remote chrome redesign passes lifecycle/access/version/remote E2E tests.
Gate 6: Cursor polish passes focused remote collaboration E2E tests.
Gate 7: Final required-auth web E2E, backend tests, typecheck, and diff check pass.
```

## Task 1: Unified Backend Access Model

**Files:**
- Modify: `apps/api/src/db/schema.sql`
- Modify: `apps/api/src/services/access-control.ts`
- Test: `apps/api/src/services/access-control.test.ts`
- Test: `apps/api/src/routes/access-routes.test.ts`

- [ ] **Step 1: Write failing backend tests**

Add tests that prove:

```text
generateAccessToken returns ml_access_ tokens.
verifyDocumentAccess accepts a valid access grant for the shared branch.
verifyDocumentAccess rejects the same grant for a different branch in the same doc.
verifyDocumentAccess rejects the same grant for a different doc.
verifyDocumentAccess rejects write when role=view.
verifyDocumentAccess accepts write when role=edit.
Creating an access grant returns the raw ml_access_ token once.
Listing access grants never returns the raw token.
Revoking an access grant blocks future reads and writes.
Creating an access session with displayName Alex stores Alex.
Creating an access session with a blank displayName returns Guest 1.
Creating another blank session on the same grant returns Guest 2.
Concurrent blank session creation cannot assign duplicate Guest N names.
Reusing the same grantId/clientId returns the same session identity.
Revoking a grant sets revoked_at and blocks future verification.
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/access-control.test.ts apps/api/src/routes/access-routes.test.ts
```

Expected: FAIL because the unified model does not exist yet.

- [ ] **Step 3: Implement schema and service**

Add `access_grants` and `access_sessions` to `apps/api/src/db/schema.sql`.

In `apps/api/src/services/access-control.ts`, add:

```ts
export type AccessGrantRole = 'view' | 'edit';
export type AccessClientKind = 'browser' | 'agent' | 'api';

export function generateAccessToken(): string {
  return `ml_access_${randomBytes(32).toString('base64url')}`;
}
```

Change document access verification to query `access_grants` by `token_hash`, `doc_id`, and `branch_id`. Branch scope is required; same-document access is not enough.

Add session helper behavior:

```text
clientId + grantId uniquely identify a session.
displayName.trim() is used when non-empty.
blank displayName becomes Guest N for that grant.
color is stable for the session and stored in the table.
last_seen_at and last_branch_id update on repeated calls.
```

- [ ] **Step 4: Implement routes**

In `apps/api/src/routes/access-routes.ts`, add:

```http
POST   /api/docs/:docId/branches/:branchId/access-grants
GET    /api/docs/:docId/branches/:branchId/access-grants
DELETE /api/access-grants/:grantId
POST   /api/docs/:docId/branches/:branchId/access-sessions
```

Keep admin-token protection for creating, listing, and revoking grants. Session creation is protected by the access link token itself.

- [ ] **Step 5: Run backend tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/access-control.test.ts apps/api/src/routes/access-routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.sql apps/api/src/services/access-control.ts apps/api/src/services/access-control.test.ts apps/api/src/routes/access-routes.ts apps/api/src/routes/access-routes.test.ts
git commit -m "feat: add unified access links"
```

## Task 2: REST and Hocuspocus Authorization

**Files:**
- Modify: `apps/api/src/http/app.ts`
- Modify: `apps/api/src/collab/server.ts`
- Test: `apps/api/src/collab/server.test.ts`
- Test: `apps/api/src/routes/doc-ai-routes.e2e.test.ts`

- [ ] **Step 1: Write failing auth tests**

Add tests that prove:

```text
read_doc accepts ml_access_ view grants on the shared branch.
read_doc rejects the same ml_access_ grant on another branch in the same doc.
write_doc rejects ml_access_ view grants on the shared branch.
write_doc accepts ml_access_ edit grants on the shared branch.
edit_doc rejects ml_access_ view grants on the shared branch.
edit_doc accepts ml_access_ edit grants on the shared branch.
edit_doc rejects the same ml_access_ edit grant on another branch in the same doc.
export.md accepts ml_access_ view grants on the shared branch.
export.md rejects the same ml_access_ view grant on another branch in the same doc.
version list and version preview accept ml_access_ view grants only for versions on the shared branch.
restore accepts ml_access_ edit grants only on the shared branch.
restore flushes active Hocuspocus before reading branch state.
restore uses LiveMarkdownWriter, persists the returned non-empty yjsState, and creates operation=rollback.
restore calls applyCollabDocumentState(roomName, applied.yjsState) so connected collaborators receive the restored document state.
branch-from-version rejects ml_access_ branch-scoped grants in Plan 6.7.
full branch list is not returned to branch-scoped ml_access_ grants.
branch-scoped summary works for a non-default branch token.
read_doc rejects the same grant for another doc.
Hocuspocus accepts ml_access_ edit grants only on the shared branch.
Hocuspocus rejects ml_access_ edit grants on another branch in the same doc.
Hocuspocus rejects ml_access_ view grants.
Revoked grants immediately fail REST verification.
Revoked grants fail new Hocuspocus authentication.
Admin token owner access still works when auth is required.
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/collab/server.test.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/routes/version-routes.test.ts apps/api/src/routes/import-export-routes.export.test.ts
```

Expected: FAIL until the auth path uses `access_grants`.

- [ ] **Step 3: Wire auth**

Keep the public route behavior unchanged, but make `requireDocumentAccess` and Hocuspocus `onAuthenticate` use the unified grant verifier. Preserve the admin-token bypass from Plan 6.6.

- [ ] **Step 4: Run tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/collab/server.test.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/routes/version-routes.test.ts apps/api/src/routes/import-export-routes.export.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/http/app.ts apps/api/src/collab/server.ts apps/api/src/collab/server.test.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/routes/version-routes.ts apps/api/src/routes/version-routes.test.ts apps/api/src/routes/import-export-routes.export.test.ts
git commit -m "feat: gate document access with unified links"
```

## Task 3: Wire Manual and Automatic Save Checkpoints

**Files:**
- Modify: `apps/api/src/services/milkdown-transformer.ts`
- Modify: `apps/api/src/services/save-policy.ts`
- Modify: `apps/api/src/routes/version-routes.ts`
- Modify: `apps/api/src/services/editor-state.ts`
- Modify: `apps/web/src/lib/api-client.ts`
- Test: `apps/api/src/services/version-service.test.ts`
- Test: `apps/api/src/routes/version-routes.test.ts`
- Test: `apps/api/src/services/editor-state.test.ts`
- Test: `apps/api/src/services/save-policy.test.ts`

- [ ] **Step 1: Write failing save tests**

Add tests around the existing checkpoint helpers that prove:

```text
Manual save flushes active Hocuspocus state before creating a version.
Manual save creates a version with operation=manual_save when content changed.
Manual save returns created=false and the current head version when content did not change.
Manual save persists the returned non-empty yjsState and mirror markdown.
Auto-save flushes active Hocuspocus state before checking for changed content.
Auto-save creates an operation=autosave version only when content changed.
Auto-save uses the existing save policy throttle/debounce so repeated calls in the same quiet window do not create duplicate versions.
Export after auto-save/manual-save reads the same freshly flushed state.
Cmd+S/Ctrl+S in the web app calls the same manual-save endpoint as the drawer button.
Save status updates after manual save and autosave.
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/version-service.test.ts apps/api/src/routes/version-routes.test.ts apps/api/src/services/editor-state.test.ts apps/api/src/services/save-policy.test.ts
```

Expected: FAIL only for missing route/UI wiring. Existing helper tests may already pass.

- [ ] **Step 3: Reuse existing checkpoint helpers for manual save**

Do not create a second save/version abstraction. Reuse the existing local paths where possible:

```text
flushBranchMarkdownMirror(pool, docId, branchId, 'manual_save')
save-policy helpers
existing document_versions operation=manual_save
existing active Hocuspocus flush hook
```

Add or expose a manual-save route that:

```text
flushes active collab state for docId/branchId,
serializes the freshly flushed Yjs state,
computes the canonical markdown hash,
compares it with the latest version hash,
returns created=false if unchanged,
creates a document version with operation=manual_save if changed,
persists the non-empty encoded yjsState from the existing flush/serialization path,
updates branch head/mirror state through the existing versioning path.
```

Expose it through a branch-scoped route such as:

```http
POST /api/docs/:docId/branches/:branchId/versions/manual-save
```

Use the existing version route naming if the repo already has a better local pattern.

- [ ] **Step 4: Wire auto-save checkpointing**

Use the same flush/serialize/version helper as manual save, but record:

```text
operation=autosave
createdBy=system or auto-save actor
```

Use the existing `save-policy` throttle unless it is insufficient. The important behavior is:

```text
live collaborative edits are durable without requiring the user to press Save,
version history is not flooded while typing,
manual Save version remains explicit and user-visible.
```

- [ ] **Step 5: Run backend save tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/version-service.test.ts apps/api/src/routes/version-routes.test.ts apps/api/src/services/editor-state.test.ts apps/api/src/services/save-policy.test.ts
npx -y pnpm@10.0.0 --filter @marklab/api typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/milkdown-transformer.ts apps/api/src/services/save-policy.ts apps/api/src/routes/version-routes.ts apps/api/src/services/editor-state.ts apps/web/src/lib/api-client.ts apps/api/src/services/version-service.test.ts apps/api/src/routes/version-routes.test.ts apps/api/src/services/editor-state.test.ts apps/api/src/services/save-policy.test.ts
git commit -m "feat: add manual and automatic save checkpoints"
```

## Task 4: Web Access Client and Self-Naming Sessions

**Files:**
- Modify: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/access-session.ts`
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx`
- Test: `apps/web/tests/access-ui.spec.ts`
- Test: `apps/web/tests/remote-document.spec.ts`

- [ ] **Step 1: Write failing web session tests**

Add tests that prove:

```text
Opening an edit access link prompts for collaborator name before joining collaboration.
Entering Alex makes other collaborators see Alex on the cursor label.
Leaving the name blank creates Guest 1.
Opening the same edit access link in a second browser context and leaving blank creates Guest 2.
Reopening the same link in the same browser keeps the same session name.
Owner/admin editing also prompts for a collaborator display name when no local name exists.
View-only links open immediately without a name prompt.
View-only links render the document, allow normal text selection/copy, and do not mount editable Milkdown or Hocuspocus.
View-only browser/API use does not create an access session or appear in Recent sessions.
AI/API attribution remains out of scope until Plan 7.
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/access-ui.spec.ts tests/remote-document.spec.ts
```

Expected: FAIL until session prompts and API methods exist.

- [ ] **Step 3: Implement API client methods**

In `apps/web/src/lib/api-client.ts`, add:

```ts
createAccessGrant(docId, branchId, { role })
listAccessGrants(docId, branchId)
revokeAccessGrant(grantId)
createAccessSession(docId, branchId, { clientId, clientKind, displayName })
manualSaveVersion(docId, branchId)
getBranchSummary(docId, branchId)
```

Remove web usage of:

```text
createAgentToken
listAgentTokens
revokeAgentToken
createShareLink
listShareLinks
revokeShareLink
```

- [ ] **Step 4: Implement session storage**

Create `apps/web/src/lib/access-session.ts`:

```ts
export function readOrCreateAccessClientId(docId: string, grantId: string): string
export function readStoredCollaboratorName(scope: string): string | null
export function storeCollaboratorName(scope: string, name: string): void
```

Use localStorage keys:

```text
marklab.accessClient.<docId>.<grantId>
marklab.collaboratorName.<scope>
```

For owner/admin identity, use a scope such as:

```text
owner.<docId>
```

For shared-link identity, use:

```text
grant.<grantId>
```

- [ ] **Step 5: Add self-name prompt**

In `RemoteDocumentPage`, when an editable session is about to join collaboration and no stored name exists, show a small modal/dialog:

```text
Name for collaboration
This is how others will see your cursor.

[ Alex                         ]
[Continue]
[Continue as Guest]
```

Rules:

```text
Guest/edit-link users name themselves.
Owner/admin users name themselves.
Blank or Continue as Guest sends blank displayName so the server assigns Guest N.
View-only links do not need this prompt because they do not join collaboration.
Read-only browser/API use has no presence identity in Plan 6.7.
The prompt is only about collaboration identity, not access permission.
Changing the local collaborator name after join lives in the Share drawer, not as a persistent page chip.
```

- [ ] **Step 6: Use session identity for awareness**

For token-authenticated edit links, call `createAccessSession` before creating the Hocuspocus provider and pass:

```ts
user: {
  name: session.displayName,
  color: session.color,
}
```

For owner/admin sessions, use the locally stored owner display name and current local color generation.

Important Milkdown rule:

```text
Session identity must flow through Yjs awareness.user.
Do not create a parallel ProseMirror decoration system for identity.
For name changes after connect, update provider.awareness.setLocalStateField('user', nextUser).
Do not call collabService.setAwareness() again after connect expecting plugins to rebuild.
```

- [ ] **Step 7: Run web session tests**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/access-ui.spec.ts tests/remote-document.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/access-session.ts apps/web/src/pages/RemoteDocumentPage.tsx apps/web/tests/access-ui.spec.ts apps/web/tests/remote-document.spec.ts
git commit -m "feat: add collaborator session identity"
```

## Task 5: Clean Remote Document Chrome

**Files:**
- Create: `apps/web/src/components/DocumentActionRail.tsx`
- Create: `apps/web/src/components/DocumentDrawer.tsx`
- Create or modify: `apps/web/src/components/VersionsDrawer.tsx`
- Create or modify: `apps/web/src/components/ShareDrawer.tsx`
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx`
- Modify: `apps/web/src/components/DocumentToolbar.tsx`
- Modify: `apps/web/src/components/BranchSwitcher.tsx`
- Modify: `apps/web/src/components/VersionHistoryPanel.tsx`
- Modify: `apps/web/src/components/ShareAccessPanel.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/tests/access-ui.spec.ts`
- Test: `apps/web/tests/version-branch-ui.spec.ts`
- Test: `apps/web/tests/document-lifecycle.spec.ts`
- Test: `apps/web/tests/remote-document.spec.ts`

- [ ] **Step 1: Write failing chrome tests**

Add or update tests that prove:

```text
The remote page initially shows no Cloud document header, MarkLab heading, full doc id, top toolbar card, permanent share/access panel, or permanent version history panel.
Owner/admin and edit-link pages initially show exactly two fixed icon buttons: Versions and Share.
View-link pages show no fixed icon buttons.
Clicking Versions opens a drawer and does not resize the editor canvas.
Clicking Share opens a drawer and closes Versions.
Escape closes the open drawer.
Clicking outside the drawer closes it.
Read-only mode shows no rail buttons, no Versions drawer, and no Share controls.
Raw request_failed JSON is not visible in the main page.
Cmd+S/Ctrl+S triggers manual save and updates the muted bottom-right save status.
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/document-lifecycle.spec.ts tests/access-ui.spec.ts tests/version-branch-ui.spec.ts tests/remote-document.spec.ts
```

Expected: FAIL until the remote chrome is redesigned.

- [ ] **Step 3: Implement `DocumentActionRail`**

Create a fixed right-side rail with two icon-only buttons:

```text
Versions button aria-label="Versions"
Share button aria-label="Share"
```

Use tooltip/title text but no visible text inside the buttons.
Use `lucide-react` icons, for example `History` and `Share2`.

- [ ] **Step 4: Implement `DocumentDrawer`**

Create a shared drawer shell:

```text
title
close button
overlay outside-click handling
Escape close
desktop width 340-380px
mobile width min(100vw, 380px) or full width
```

- [ ] **Step 5: Move document state controls into Versions drawer**

Move these controls into the drawer:

```text
Back to documents
current branch selector for owner/admin
current branch label for branch-scoped edit grants
Save version
export markdown
version list
version preview
branch from selected version
restore selected version
```

Wire `Save version` to the manual-save route from Task 3. Wire `Cmd+S` / `Ctrl+S` to the same route. Show a quiet `Saved`, `Autosaved`, `Manual saved`, `Saving`, `Unsaved changes`, or `No changes to save` status in the drawer or bottom-right status area.

For branch-scoped edit grants:

```text
show the current branch name,
do not show a full branch switcher,
do not allow Branch from this version,
allow Restore this version only for versions on the current branch.
```

Restore UI rule:

```text
Restore is a shared branch action.
After restore succeeds, show a quiet status such as "Restored version".
Do not imply restore is local to this browser.
Connected collaborators should see the document update through the shared Hocuspocus room.
```

- [ ] **Step 6: Move access controls into Share drawer**

Move these controls into the drawer:

```text
create view/edit access link
created access link copy UI
Copy AI prompt
active access links
recent sessions
change my collaboration name
revoke access link
```

Remove the separate agent-token section from the default UI. Agents use the same access link.
Create links for the current branch only. The active links list in a branch drawer lists grants for that branch.
Allow both owner/admin and branch-scoped edit grants to use these controls for the current branch.
Do not allow view grants to load this drawer.

- [ ] **Step 7: Replace raw errors**

Map raw request/API errors to readable messages:

```text
Unable to load document.
Unable to load versions.
Unable to load share settings.
Unable to create access link.
Unable to revoke access link.
```

Detailed error text may go to `console.error` or a quiet `<details>` element inside the drawer, not the main page.

- [ ] **Step 8: Run chrome tests**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/document-lifecycle.spec.ts tests/access-ui.spec.ts tests/version-branch-ui.spec.ts tests/remote-document.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/DocumentActionRail.tsx apps/web/src/components/DocumentDrawer.tsx apps/web/src/components/VersionsDrawer.tsx apps/web/src/components/ShareDrawer.tsx apps/web/src/pages/RemoteDocumentPage.tsx apps/web/src/components/DocumentToolbar.tsx apps/web/src/components/BranchSwitcher.tsx apps/web/src/components/VersionHistoryPanel.tsx apps/web/src/components/ShareAccessPanel.tsx apps/web/src/styles.css apps/web/tests/access-ui.spec.ts apps/web/tests/version-branch-ui.spec.ts apps/web/tests/document-lifecycle.spec.ts apps/web/tests/remote-document.spec.ts
git commit -m "feat: simplify remote document chrome"
```

## Task 6: Cursor Labels

**Files:**
- Modify: `apps/web/src/components/MilkdownEditor.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/tests/remote-document.spec.ts`

- [ ] **Step 1: Write failing cursor tests**

Add tests that prove:

```text
Remote cursor label shows the session display name after the remote editor is focused or has a selection.
Two sessions using the same access link have different names and colors.
The label is attached near the cursor.
There is no full-width filled collaborator bar.
Selections remain colored.
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/remote-document.spec.ts
```

Expected: FAIL until cursor labels use session identity.

- [ ] **Step 3: Implement cursor label builder**

Use Milkdown's existing collab plugin extension points:

```text
collabServiceCtx -> bindDoc(ydoc) -> mergeOptions({ yCursorOpts }) -> setAwareness(awareness) -> connect()
```

Rules from `@milkdown/plugin-collab` and `y-prosemirror`:

- `setAwareness(awareness)` must happen before `connect()` so `yCursorPlugin` is mounted.
- `setOptions()` replaces all collab options. Prefer `mergeOptions({ yCursorOpts })` unless all options are owned in one place.
- Cursor labels belong in `yCursorOpts.cursorBuilder(user)`.
- Selection color belongs in `yCursorOpts.selectionBuilder(user)`.
- The user payload comes from `awareness.user`, so pass `{ name, color }` through `provider.awareness.setLocalStateField('user', ...)`.
- Do not create custom overlay decorations outside the Milkdown/Yjs cursor plugin.
- Do not depend on `ydoc.clientID` for persisted identity. Use the server-returned session color for access-link sessions.

Render:

```html
<span class="ProseMirror-yjs-cursor marklab-collab-cursor">
  <span class="marklab-collab-cursor-label">Alex</span>
</span>
```

Style:

```text
thin colored cursor line
small label above/right of cursor
label background very light or same color with restrained opacity
label text legible
no wide filled horizontal bar
selection background uses the session color with transparency
```

- [ ] **Step 4: Run cursor tests**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/remote-document.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/MilkdownEditor.tsx apps/web/src/styles.css apps/web/tests/remote-document.spec.ts
git commit -m "feat: show named collaborator cursors"
```

## Task 7: Final Plan 6.7 Verification

**Files:**
- Review all files touched by Tasks 1-6.

- [ ] **Step 1: Backend tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/access-control.test.ts apps/api/src/routes/access-routes.test.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/collab/server.test.ts apps/api/src/services/version-service.test.ts apps/api/src/routes/version-routes.test.ts apps/api/src/services/editor-state.test.ts apps/api/src/services/save-policy.test.ts apps/api/src/routes/import-export-routes.export.test.ts
```

Expected: PASS.

- [ ] **Step 2: Required-auth web E2E**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web test:e2e
```

Expected: PASS, with only explicitly documented skips.

- [ ] **Step 3: Full typecheck**

Run:

```bash
npx -y pnpm@10.0.0 typecheck
```

Expected: PASS.

- [ ] **Step 4: Whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Manual smoke test**

Verify:

```text
Default remote doc page shows the editor/document and only two right-side buttons.
Edit-link remote doc page also shows Versions and Share for the shared branch.
View-link remote doc page shows no right-side buttons.
Versions drawer opens and contains branch/version/export/back controls.
Versions drawer can manually save a new version.
Cmd+S/Ctrl+S triggers manual save and updates the muted save status.
Automatic save creates quiet checkpoints for changed collaborative edits without flooding history.
Restore creates a rollback version and updates active connected collaborators through applyCollabDocumentState.
Versions drawer preview selection remains local to the browser and does not change other collaborators' drawer UI.
Share drawer opens and creates one access link value.
Created access link has Copy and Copy AI prompt actions.
Edit-link collaborators can create/revoke links for the shared branch.
Revoking a link blocks all sessions using that link, not just one browser identity.
Opening an edit link asks the collaborator to name themselves.
Two browser contexts using the same link show as different named collaborators.
Leaving name blank becomes Guest 1, Guest 2, etc.
Concurrent blank joins do not duplicate Guest N names.
View link renders the current branch as read-only, allows selecting/copying document text, and does not mount editable Hocuspocus.
Read-only/API use creates no collaborator identity in Plan 6.7.
View link and AI/read access cannot read or switch to another branch in the same document.
Revoking the access link blocks future read/write/collab access.
Raw API JSON is not visible in normal UI.
```

## Deployment Gate

Plan 6.7 is complete only when:

```text
Share links and agent tokens are replaced in the UI by one access-link model.
New access links use ml_access_ tokens.
Access grants are branch-scoped.
The URL branch is the shared branch and the access scope.
The access-link panel shows one value, not separate browser and token values.
Edit grants can use Versions and Share drawers for the shared branch.
Edit grants cannot use the same token to switch to another branch.
Editable guests and agents name themselves when they join collaboration.
View-only guests and AI/read access open without a collaboration name prompt.
Read-only/API use does not create collaboration identity in Plan 6.7.
Blank collaborator names become Guest N.
Guest N assignment is race-safe.
The owner/admin can set the name shown to collaborators.
One access link can have many sessions.
Revoking a link revokes access for everyone using that link.
Cursors show session identity and session color.
The default owner/editable/edit-link remote page is a clean document/editor canvas with only Versions and Share icon buttons.
Read-only pages show no rail buttons or admin drawers.
Versions and Share are overlay drawers and do not resize the editor.
Read-only links render a clean document view and do not mount editable Hocuspocus.
Manual save and auto-save both flush active Hocuspocus before creating versions.
Restore flushes active Hocuspocus, writes rollback through LiveMarkdownWriter, persists returned yjsState, and applies that yjsState back to active Hocuspocus.
Cmd+S/Ctrl+S triggers manual save.
Muted save status shows saving state and last manual/autosave time.
Raw tokens are stored only as hashes and are not returned by list routes.
Admin/bootstrap token behavior from Plan 6.6 still works.
```

## Suggested Commit Sequence

```bash
feat: add unified access links
feat: gate document access with unified links
feat: wire manual and automatic save checkpoints
feat: add collaborator session identity
feat: simplify remote document chrome
feat: show named collaborator cursors
test: verify unified access link flows
```
