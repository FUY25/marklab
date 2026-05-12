# Control Plane MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the login-backed control-plane foundation for users, workspaces, members, share keys, document grants, guest sessions, seat limits, and subscription records.

**Architecture:** MarkLab owns product identity and permissions; Y-Sweet owns provider sync only. The control plane validates user/session/link/seat rules before issuing provider tokens, and stores the authoritative audit metadata that clients cannot forge through Yjs.

**Tech Stack:** Express, PostgreSQL/Neon, existing `apps/api` route/service pattern, zod, Vitest, browser/native session clients.

## Reference Implementations (MIT — OK to copy)

This plan is mostly original MarkLab work (workspace/seat/billing schema is MarkLab-specific), but a few Relay files contain MIT-licensed patterns you can copy and adapt rather than re-derive.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** Even though this plan is mostly MarkLab-original, several Relay files (OIDC claim handling, role/permission checks, token refresh) save real time when copied as starting points. Don't re-author what's already debugged — adapt the existing code instead.
2. **`Learning resources/` is read-only as a directory.** Never edit, move, delete, or `git add` anything under it. Read freely; paste into MarkLab-owned files.
3. **Preserve attribution.** When copying non-trivial code, paste the upstream LICENSE/copyright header as a comment.
4. **Adapt to MarkLab conventions** — Relay's Pocketbase backend, Obsidian plugin patterns, and S3RN encoding are project-specific. Lift the structural shape, not the surface coupling.

| This plan's task | Lift from | What to copy |
|---|---|---|
| Task 3 (auth MVP) | `Learning resources/Relay/src/LoginManager.ts` | The OIDC-style claim-handling shape (`Handle OIDC user (standard OpenID Connect claims)` section). Replace Relay's Pocketbase-specific backend calls with MarkLab's chosen auth backend. |
| Task 4 (workspace role enforcement) | `Learning resources/Relay/src/PolicyManager.ts` | The role/permission check pattern. Adapt to MarkLab's `Owner` / `Member` / `Reader` set. |
| Task 5 (provider token refresh route) | `Learning resources/Relay/src/LiveTokenStore.ts:35-103` | The `refresh(documentId, onSuccess, onError)` server-side flow. Plan 1A already adapted this; here you extend it to re-check grant/session/role/expiry/revocation before issuing a fresh token. New guest sessions still enforce quota at initial token issuance. |
| Task 6 (audit boundary) | `Learning resources/Relay/src/HasProvider.ts:77-84` (client-side example) | The pattern for binding clientID to identity. MarkLab inverts this: client binds for UI, server audits from validated session state. Copy the binding code, add the MarkLab-side audit-never-reads-PermanentUserData rule. |
| Task 7B (workspace settings UI shell) | `Learning resources/collabmd/` | Markdown collaboration page chrome (layout, CSS, tab structure). Lift CSS/layout snippets; do not adopt collabmd's sync/server code. |

---

## Scope

This plan makes the MVP public-login-backed. It does not build full enterprise admin, SSO, or folder collaboration. It includes folder/private-folder schema hooks so future folder work does not require a control-plane rewrite.

## Provider Runtime Facts From Plan 1B

- Plan 1B added a real API-supervised Y-Sweet 0.9.1 process mode and `/healthz` now gates production readiness on database, schema, relay, provider `/ready`, and authenticated provider `/check_store`.
- The schema readiness gate already includes provider/session tables and provider columns: `document_branch_states.provider_doc_id`, `document_branch_states.provider_doc_seeded_at`, `collab_sessions`, and `provider_token_issuances`. Task 2 may rename/extend these tables for the control-plane model, but it must update the health schema contract at the same time and add a regression for missing renamed tables/columns.
- `MARKLAB_YSWEET_PUBLIC_URL_PREFIX` is root-mounted and HTTPS-only in API-supervised process mode; do not introduce browser/client contracts that require a path-prefixed provider URL.

## File Structure

- Modify `apps/api/src/db/schema.sql`
- Create `apps/api/src/services/user-service.ts`
- Create `apps/api/src/services/workspace-service.ts`
- Create `apps/api/src/services/control-plane-access.ts`
- Create `apps/api/src/routes/auth-routes.ts`
- Create `apps/api/src/routes/workspace-routes.ts`
- Modify `apps/api/src/routes/collab-session-routes.ts`
- Modify `apps/api/src/services/access-control.ts`
- Modify `apps/api/src/http/app.ts`
- Add tests beside each new service/route.
- Do not modify `apps/collab-web` in this plan. The app does not exist until `2026-05-11-collab-web-app.md`; browser session wiring is deferred there.
- Do not modify native app files in this plan unless they already exist and are needed for server contract tests. Native session wiring is deferred to `2026-05-11-marklab-native-integration.md`.
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: Existing Schema Migration Inventory And Decisions

The existing schema at `apps/api/src/db/schema.sql` has two parallel access systems from the alpha:

1. **Generic document access** (kept and extended in this plan):
   - `access_grants` — per-document view/edit links keyed by `token_hash`.
   - `access_sessions` — sessions joined via a grant.
   - `share_links` — older link table predating `access_grants`.

2. **Relay-room access** (deprecated by this plan; data preserved read-only until Plan 8 final deploy):
   - `relay_rooms`, `relay_access_grants`, `relay_access_sessions` — host-gated relay alpha model. The Y-Sweet provider replaces host-gating, so these tables hold no new writes after the control-plane MVP ships.

Decisions for this plan (codify before writing migrations):

- **Extend, do not parallel-create.** Rename `access_grants` to `document_access_grants` via a SQL `alter table … rename` (preserves rows, FK, and indexes) and add `workspace_id`, `folder_id`, and `created_by_user_id` columns. Do not create a second `document_access_grants` table.
- **Rename `access_sessions` to `document_access_sessions`** for naming consistency with `document_access_grants`. Add `actor_kind` (`user`, `guest`, `agent`, `daemon`) and `actor_id` (nullable for guests/agents).
- **Deprecate `share_links`**: keep the table read-only; mark it `-- legacy, do not write` in schema.sql; the API stops writing to it in Task 5. Drop in a future cleanup migration.
- **Freeze DB-backed hosted `relay_*` tables**: leave the SQL definitions but stop writing to them from the hosted/public control-plane app after this plan. Add a `-- legacy: host-gated alpha, do not write` comment. Drop after Plan 8 confirms no production reader is left. The local-file compatibility relay API may remain mounted in `localMode` only when backed by the in-memory/remote local relay services wired in `apps/api/src/index.ts`; it must not be wired to the DB-backed `relay_*` persistence path.
- **Add `provider_token_issuances` FK** for `session_id` to `collab_sessions(id)` unless this task explicitly replaces the Plan 1B edit-session table. If replacing it, migrate the token issuance routes/services, refresh logic, and `/healthz` schema readiness contract in the same task before adding the FK.

Subtasks:

- [x] Run the table-by-table inventory and confirm the decisions above against the current `schema.sql`. If a table is missing, add it here before Task 2.
- [x] Write the rename/extend SQL into Task 2 explicitly; do not defer it to implementation.
- [x] Grep `apps/api/src` for production readers of `share_links`; legacy readers were identified before implementation, then removed after schema migration copied legacy rows into `document_access_grants`.
- [x] Acceptance: an engineer can read this task and tell exactly which tables are renamed, which are deprecated read-only, and which are dropped in a later migration.

Inventory result during execution:

- `access_grants` and `access_sessions` existed and were renamed to `document_access_grants` and `document_access_sessions`.
- `share_links` remains as a legacy read-only table. Existing rows are copied into `document_access_grants` during schema setup, production access/token paths no longer query `share_links` directly, and no production `insert into share_links` / `update share_links` remains.
- `relay_rooms`, `relay_access_grants`, and `relay_access_sessions` remain in schema for host-gated alpha compatibility and are marked legacy read-only. Hosted/public control-plane routing no longer writes them; local-file relay compatibility remains local-mode-only and is wired to in-memory or remote relay services by `apps/api/src/index.ts`, not to the DB-backed `relay_*` persistence path.

### Task 2: Data Model

This task ships the SQL described by Task 1's decisions plus the new workspace/folder/plan schema. The SQL appears in `apps/api/src/db/schema.sql` in the order below; tests live in `apps/api/src/db/schema.test.ts`.

New tables:

- `users` — logged-in identities.
- `workspaces` — workspace-scoped container; contains many documents.
- `workspace_members` — `(workspace_id, user_id, role)` with role `Owner` / `Member` / `Reader`.
- `workspace_share_keys` — workspace-join invite keys with `token_hash`, expiry, revocation.
- `workspace_folders` — folder hierarchy stub (used in Phase 5 but the schema lands now to avoid retrofitting).
- `folder_access_policies` — folder-scoped access policy stub.
- `plans` — plan definitions (`free`, `team`, `business`, `internal`).
- `seat_limits` — `(plan_id, member_seats, concurrent_guest_edits)`.
- `subscriptions` — `(workspace_id, plan_id, status, current_period_end)`.

Schema changes to existing tables (per Task 1):

- `alter table access_grants rename to document_access_grants;` plus `add column workspace_id`, `folder_id`, `created_by_user_id`.
- `alter table access_sessions rename to document_access_sessions;` plus `add column actor_kind`, `actor_id`.
- `alter table documents add column workspace_id`, `folder_id` (nullable until backfilled).
- `alter table provider_token_issuances add constraint provider_token_issuances_session_fk foreign key (session_id) references collab_sessions(id)` — see Task 1; backfill before adding the constraint. Do not point edit-token issuances at `document_access_sessions` unless this plan also migrates all token issuance and refresh code away from `collab_sessions` in the same commit.
- Add `-- legacy, do not write` SQL comments above `share_links`, `relay_rooms`, `relay_access_grants`, `relay_access_sessions`.

Refresh-related additions:

- `provider_token_refreshes` — `(id, session_id, issued_at, expires_at, denied_at, deny_reason)` records refresh attempts after the refresh token matches an active edit session, for audit and revocation diagnostics. Wrong refresh-token probes are rejected before inserting here to avoid unauthenticated audit-row spam. Edit sessions request a new Y-Sweet `ClientToken` via this table's flow before `expires_at` minus the refresh margin.

Subtasks:

- [x] Write `apps/api/src/db/schema.test.ts` covering: workspace creation, role check constraint, plan seed insert, document `workspace_id` backfill nullable, rename preserves grant rows, FK on `provider_token_issuances.session_id` to `collab_sessions(id)` rejects unknown edit sessions.
- [x] Update the `/healthz` schema readiness contract in `apps/api/src/http/app.ts` and `apps/api/src/index.ts` for any renamed provider/session tables or columns. Add a health test proving missing control-plane/provider-token tables or columns return `503`.
- [x] Run the schema test before writing migration SQL (expect failures).
- [x] Add the SQL block-by-block, running the schema test after each block.
- [x] Preserve compatibility with existing document/import/version tests by keeping `documents.workspace_id` nullable in this plan; a later plan can require it once backfill is complete.
- [x] Acceptance command: `npx -y pnpm@10.0.0 test apps/api/src/db/schema.test.ts apps/api/src/routes/documents-routes.test.ts apps/api/src/routes/versions-routes.test.ts` passes.

Execution note: this repository has `apps/api/src/routes/version-routes.test.ts` and no `documents-routes.test.ts` / `versions-routes.test.ts` files. The equivalent current gate was run through the full `apps/api/src/services` and `apps/api/src/routes` acceptance suite plus `apps/api/src/db/schema.test.ts`.

### Task 3: Auth MVP

- [x] Implement a login-backed session mechanism suitable for alpha.
- [x] Store server-side session records and secure cookies or bearer tokens.
- [x] Keep anonymous access restricted to explicit dev-mode env.
- [x] Add tests for logged-in user, guest session, expired session, and dev-mode anonymous session.
- [x] Acceptance: public collab session creation fails without a valid user or guest session.

### Task 4: Workspace Membership

- [x] Implement workspace creation for a first user.
- [x] Implement member roles: `Owner`, `Member`, `Reader`.
- [x] Implement workspace share keys for joining a workspace.
- [x] Enforce member-seat limit when adding named members.
- [x] Acceptance: a `Reader` can view allowed docs but cannot issue edit provider tokens.

### Task 5: Document Grants, Guest Sessions, And Token Refresh

- [x] Implement view/edit document grants as long-lived share links.
- [x] Convert every share-link open into a server-side session.
- [x] Enforce guest concurrent edit quota at provider-token issuance time. The implementation reads `seat_limits.concurrent_guest_edits` through the workspace subscription/plan and uses the legacy free-plan fallback constant only for documents without a workspace/plan row.
- [x] Implement provider-token refresh for edit sessions. The refresh endpoint must re-check grant status, session status, role, expiry, and revocation before issuing a fresh Y-Sweet `ClientToken`. It must not re-run the concurrent-guest quota against already-active guest sessions because `docs/appdesigndoc.md` says quota blocks new guest sessions while existing guest sessions remain unaffected.
- [x] Deny provider token refresh after grant revocation.
- [x] Acceptance: revoking an edit link blocks the next token refresh and revoking a view link blocks the next snapshot fetch.

Execution note: `docs/appdesigndoc.md` says concurrent-guest-edit quota blocks new guest sessions while existing guest sessions remain unaffected. The implementation therefore enforces the workspace plan quota during initial edit-token issuance and continues to refresh already-active guest sessions after re-checking grant/session/role/expiry/revocation.

### Task 6: Control-Plane Audit Metadata

- [x] Record provider token issuances with user/session/grant/workspace/document metadata (extends Plan 1A's `provider_token_issuances` for edit sessions).
- [x] Log **view-session accesses** in `document_access_sessions` with `actor_kind` and `actor_id`. Plan 1A intentionally deferred this; the current view-mode route in `collab-session-routes.ts` returns a control-plane snapshot without minting a provider token and does not yet write a view-session audit row. This task must add that audit write before returning the snapshot.
- [x] Enforce `Y.PermanentUserData` as UI attribution only:
  - Server-side audit code (token-issuance writer, version-attribution writer, conflict-resolution writer) reads identity exclusively from the validated control-plane session, never from `Y.PermanentUserData`.
  - Add a code comment in each audit writer linking to this rule.
  - Add a server-side test that simulates a client writing a forged `PermanentUserData` mapping (different user id) and confirms the audit row records the server-validated actor, not the forged client value.
- [x] Add tests proving clients cannot provide authoritative actor ids in the collab session request body — the route ignores any client-supplied `actorId` and derives the actor from the session middleware.
- [x] Acceptance: audit records are derived from server-validated session identity for both edit and view sessions; the `PermanentUserData` forgery test passes.

### Task 7: Client Session Contract Handoff

- [x] Do not edit `apps/collab-web` here. Record the browser requirements for Plan 3: carry login/guest session state when joining links, refresh provider tokens through the control-plane refresh endpoint, stop editing when refresh is denied, and show unavailable states for seat/quota/revocation failures.
- [x] Do not edit native app files here unless the files already exist and a server contract test requires a fixture. Record the native requirements for Plan 4: distinguish logged-in user, guest, and agent sessions; refresh provider tokens through the same endpoint; stop editing when refresh is denied.
- [x] Acceptance: server-side route/service tests prove permission, quota, expiry, and revocation failures return explicit errors that browser/native clients can surface later without falling back to anonymous edit.

Execution note: legacy `apps/web` remote editing is not the formal Plan 3 `apps/collab-web` surface and is not wired to Y-Sweet `ClientToken` refresh in this plan. Plan 2 closes the hosted `/collab` websocket bypass unless `MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB=true`; Plan 3 must replace browser edit wiring with the control-plane session + Y-Sweet client flow before public browser editing is considered shipped.

### Task 7B: Workspace Settings UI Shell Contract

This plan defines the server contract for a future `apps/collab-web` workspace settings surface. The actual browser UI is deferred until `2026-05-11-collab-web-app.md` creates the app. Billing screens (`2026-05-11-billing-subscription-seats.md`) and future folder/admin work will fill panels into this shell.

- [x] Implement server APIs needed by future `/workspaces/:workspaceId/settings`: member list, invite via share key, role change, remove member, and workspace document list with view/edit grant counts.
- [x] Record the intended browser route and tabs in Plan 3's deferred browser section: Members and Documents in v1; Plan & Billing filled by `2026-05-11-billing-subscription-seats.md`; Folders filled by a future folder plan.
- [x] Owner-only sensitive actions enforce role server-side.
- [x] Acceptance: server route tests prove Owner can list/invite/change/remove members and list workspace documents; non-Owner receives read-only or forbidden responses as appropriate.

### Task 8: Verification

- [x] Run `npx -y pnpm@10.0.0 test apps/api/src/services apps/api/src/routes`.
- [x] Run `npx -y pnpm@10.0.0 exec tsc --noEmit -p apps/api/tsconfig.json`.
- [x] Run browser/native permission smoke.
- [x] Run `git diff --check`.
- [x] Commit with `git commit -m "feat: add control plane mvp"`.

Execution note: browser/native app wiring is deferred by this plan, so the smoke gate is the automated server contract suite proving explicit errors for auth, role, quota, revocation, and refresh denial.

### Task 9: Downstream Plan Refresh

- [x] Review schema, route contracts, session cookies/tokens, guest quota behavior, and revocation behavior.
- [x] Update `docs/appdesigndoc.md` if any product permission decision changed.
- [x] Update these downstream plans:
  - `docs/plans/2026-05-11-collab-web-app.md`
  - `docs/plans/2026-05-11-marklab-native-integration.md`
  - `docs/plans/2026-05-11-reconnect-conflict-hardening.md`
  - `docs/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`
- [x] Run `rg -n "anonymous|guest|seat|workspace|share key|subscription|revocation|refresh" docs/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after control plane"`.

Execution note: no `docs/appdesigndoc.md` edit was needed because the implementation matched the existing permission model. The refresh captured implementation facts in downstream plan files: workspace-owned create/import via `workspaceId`, production-disabled dev login, delivered workspace settings APIs, plan-table-backed member/guest limits, and refresh-token behavior.
