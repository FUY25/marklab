# Control Plane MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the login-backed control-plane foundation for users, workspaces, members, share keys, document grants, guest sessions, seat limits, and subscription records.

**Architecture:** MarkLab owns product identity and permissions; Y-Sweet owns provider sync only. The control plane validates user/session/link/seat rules before issuing provider tokens, and stores the authoritative audit metadata that clients cannot forge through Yjs.

**Tech Stack:** Express, PostgreSQL/Neon, existing `apps/api` route/service pattern, zod, Vitest, browser/native session clients.

---

## Scope

This plan makes the MVP public-login-backed. It does not build full enterprise admin, SSO, or folder collaboration. It includes folder/private-folder schema hooks so future folder work does not require a control-plane rewrite.

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
- Modify `apps/collab-web/src/api/collab-session.ts`
- Modify native app auth/session integration files from Plan 3.
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: Existing Schema Migration Inventory

- [ ] Inventory the existing access tables in `apps/api/src/db/schema.sql`: `share_links`, `access_grants`, `access_sessions`, `relay_rooms`, `relay_access_grants`, and `relay_access_sessions`.
- [ ] Decide which tables are extended, which are renamed, and which are deprecated.
- [ ] Document the compatibility path in this plan before changing schema.
- [ ] Do not create duplicate parallel tables such as a new `document_access_grants` plus the existing `access_grants` unless the migration explicitly maps reads/writes and cleanup.
- [ ] Acceptance: an engineer can tell which existing alpha links/sessions survive the migration and which old relay-only tables are legacy.

### Task 2: Data Model

- [ ] Add tables for:
  - `users`;
  - `workspaces`;
  - `workspace_members`;
  - `workspace_share_keys`;
  - `workspace_folders`;
  - `folder_access_policies`;
  - `documents.workspace_id`;
  - `documents.folder_id`;
  - `document_access_grants`;
  - `access_sessions`;
  - `plans`;
  - `seat_limits`;
  - `subscriptions`.
- [ ] Add or extend a provider-token refresh table/session field so active edit sessions can request a new 10-minute Y-Sweet token before expiry.
- [ ] Preserve compatibility with existing document/import/version tests.
- [ ] Acceptance command: API schema tests pass and existing document routes still work.

### Task 3: Auth MVP

- [ ] Implement a login-backed session mechanism suitable for alpha.
- [ ] Store server-side session records and secure cookies or bearer tokens.
- [ ] Keep anonymous access restricted to explicit dev-mode env.
- [ ] Add tests for logged-in user, guest session, expired session, and dev-mode anonymous session.
- [ ] Acceptance: public collab session creation fails without a valid user or guest session.

### Task 4: Workspace Membership

- [ ] Implement workspace creation for a first user.
- [ ] Implement member roles: `Owner`, `Member`, `Reader`.
- [ ] Implement workspace share keys for joining a workspace.
- [ ] Enforce member-seat limit when adding named members.
- [ ] Acceptance: a `Reader` can view allowed docs but cannot issue edit provider tokens.

### Task 5: Document Grants, Guest Sessions, And Token Refresh

- [ ] Implement view/edit document grants as long-lived share links.
- [ ] Convert every share-link open into a server-side session.
- [ ] Enforce guest concurrent edit quota at provider-token issuance time.
- [ ] Implement provider-token refresh for edit sessions. The refresh endpoint must re-check grant status, session status, role, expiry, and quota before issuing a fresh Y-Sweet `ClientToken`.
- [ ] Deny provider token refresh after grant revocation.
- [ ] Acceptance: revoking an edit link blocks the next token refresh and revoking a view link blocks the next snapshot fetch.

### Task 6: Control-Plane Audit Metadata

- [ ] Record provider token issuances with user/session/grant/workspace/document metadata.
- [ ] Ensure `Y.PermanentUserData` remains UI attribution only.
- [ ] Add tests proving clients cannot provide authoritative actor ids in collab session request body.
- [ ] Acceptance: audit records are derived from server-validated session identity.

### Task 7: Browser And Native Session Integration

- [ ] Update `apps/collab-web` to carry login/guest session state when joining links.
- [ ] Update native app session storage to distinguish logged-in user, guest, and agent.
- [ ] Update both clients to refresh provider tokens through the control plane and to stop editing when refresh is denied.
- [ ] Show unavailable states for seat/quota/revocation failures.
- [ ] Acceptance: browser and native both surface permission errors without falling back to anonymous edit.

### Task 8: Verification

- [ ] Run `npx -y pnpm@10.0.0 test apps/api/src/services apps/api/src/routes`.
- [ ] Run `npx -y pnpm@10.0.0 exec tsc --noEmit -p apps/api/tsconfig.json`.
- [ ] Run browser/native permission smoke.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: add control plane mvp"`.

### Task 9: Downstream Plan Refresh

- [ ] Review schema, route contracts, session cookies/tokens, guest quota behavior, and revocation behavior.
- [ ] Update `docs/appdesigndoc.md` if any product permission decision changed.
- [ ] Update these downstream plans:
  - `docs/superpowers/plans/2026-05-11-collab-web-app.md`
  - `docs/superpowers/plans/2026-05-11-marklab-native-integration.md`
  - `docs/superpowers/plans/2026-05-11-reconnect-conflict-hardening.md`
  - `docs/superpowers/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/superpowers/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/superpowers/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "anonymous|guest|seat|workspace|share key|subscription|revocation|refresh" docs/superpowers/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after control plane"`.
