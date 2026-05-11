# Reconnect Conflict Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offline/reconnect behavior and Relay-like conflict UX reliable enough for alpha users.

**Architecture:** The reconciliation engine from Plan 1A opens conflicts when disk and provider diverge from `lastProjectedMarkdown`. This plan builds the user-facing review flow, pauses only the affected document, records snapshots, and proves the core failure modes with E2E tests.

**Tech Stack:** Existing local conflict store/routes, browser UI, native UI, Yjs, Vitest, Playwright, CLI smoke scripts.

---

## Scope

This plan does not add AI-assisted merge or hunk-level merge. It ships the simple Relay-like choices: keep shared, accept local, or paste resolved content.

## File Structure

- Modify `apps/api/src/local/local-conflict-store.ts`
- Modify `apps/api/src/local/local-conflict-routes.ts`
- Modify `apps/api/src/local/local-file-service.ts`
- Modify `apps/api/src/local/local-conflict-store.test.ts`
- Modify `apps/api/src/routes/local-conflict-routes.test.ts`
- Modify `apps/collab-web/src/` conflict UI files created in Plan 2.
- Modify native conflict UI files created in Plan 3.
- Modify `apps/cli/marklab.mjs`
- Modify `apps/cli/agent-conflict.test.mjs`
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: Conflict State Contract

- [ ] Ensure conflict payload includes:
  - conflict id;
  - base Markdown and hash when available;
  - local disk Markdown and hash;
  - shared provider Markdown and hash;
  - shared revision/fingerprint;
  - status.
- [ ] Add route tests for current conflict and historical conflict fetch.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 test apps/api/src/routes/local-conflict-routes.test.ts`.

### Task 2: Resolution Actions

- [ ] Ensure `use-shared` writes shared Markdown to disk and updates provider baseline.
- [ ] Ensure `use-local` replaces provider Y.Text with disk Markdown via one transaction.
- [ ] Ensure `resolve` applies pasted resolved Markdown to disk and provider.
- [ ] Record pre-resolution and post-resolution snapshots.
- [ ] Acceptance: each resolution action ends with disk/provider/current summary hash matching.

### Task 3: Browser Conflict UI

- [ ] Add conflict banner for edit sessions.
- [ ] Show local/shared/base preview before resolution choices.
- [ ] Disable editing while the document conflict is open.
- [ ] Provide actions: keep shared, accept local, paste resolved.
- [ ] Acceptance: browser user can resolve a conflict and editing resumes.

### Task 4: Native Conflict UI

- [ ] Mirror browser conflict UX in native app.
- [ ] Preserve the preview-first model.
- [ ] Ensure only the conflicted document pauses; other open documents continue.
- [ ] Acceptance: native user can resolve a conflict produced by browser/offline edits.

### Task 5: CLI Conflict UX

- [ ] Ensure `marklab conflict <file.md> --json` returns current conflict.
- [ ] Add CLI commands or documented local route usage for:
  - use shared;
  - use local;
  - resolve with a file.
- [ ] Acceptance: an agent can inspect conflict state without opening native UI.

### Task 6: E2E Reconnect Matrix

- [ ] Add tests for:
  - host online, browser edit, disk projection;
  - host offline, browser edit, host returns with disk unchanged;
  - host offline, browser edit, local disk edit, conflict opens;
  - grant revoked, token refresh denied;
  - view link never connects to provider;
  - same-Mac two-user smoke.
- [ ] Acceptance: matrix passes locally and failing cases show actionable errors.

### Task 7: Verification

- [ ] Run `npx -y pnpm@10.0.0 test apps/api/src/local apps/api/src/routes/local-conflict-routes.test.ts apps/cli`.
- [ ] Run browser/native conflict E2E smoke.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: harden reconnect conflict ux"`.

### Task 8: Downstream Plan Refresh

- [ ] Review conflict payload, UI behavior, CLI behavior, and E2E matrix.
- [ ] Update `docs/appdesigndoc.md` if conflict behavior or resolution choices changed.
- [ ] Update these downstream plans:
  - `docs/superpowers/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/superpowers/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/superpowers/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "conflict|lastProjectedMarkdown|use shared|accept local|offline|reconnect|revoked" docs/superpowers/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after conflict hardening"`.
