# Reconnect Conflict Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offline/reconnect behavior and Relay-like conflict UX reliable enough for alpha users.

**Architecture:** The reconciliation engine from Plan 1A opens conflicts when disk and provider diverge from `lastProjectedMarkdown`. This plan builds the user-facing review flow, pauses only the affected document, records snapshots, and proves the core failure modes with E2E tests.

**Tech Stack:** Existing local conflict store/routes, browser UI, native UI, Yjs, Vitest, Playwright, CLI smoke scripts.

## Reference Implementations (MIT — OK to copy)

Relay's `src/differ/` directory is a working MIT-licensed side-by-side diff UI with hunk-level action buttons. The merge-banner pattern from `y-codemirror.next/LiveEditPlugin.ts` is the exact "click to resolve" UI this plan ships. Copy these files into MarkLab-owned packages and adapt.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** Relay's `differ/` directory is a complete working diff UI with hunk-level actions. Re-implementing a side-by-side diff renderer from scratch is wasted effort. Lift the diff data model, the renderer, and the action buttons; adapt the DOM layer to React or SwiftUI.
2. **`Learning resources/` is read-only as a directory.** Never edit, move, delete, or `git add` anything under it. Read freely; paste into MarkLab-owned files.
3. **Preserve attribution.** Copy the upstream LICENSE/copyright header into each adopted file.
4. Strip Obsidian-specific calls (DOM helpers, `EmbedBanner`) and adapt to React (browser) or SwiftUI/AppKit (native).

| This plan's task | Lift from | What to copy |
|---|---|---|
| Task 1 (conflict state contract) | `Learning resources/Relay/src/Document.ts:231-274` (`checkStale`) | The conflict state the function produces (text/disk/base) maps 1:1 to MarkLab's conflict payload. Lift the structure. |
| Task 2 (resolution action: accept local) | `Learning resources/Relay/src/y-diffMatchPatch.ts` | Same diff-match-patch loop Plan 1A uses; here it applies disk content into Y.Text as a single origin-tagged transaction. |
| Task 2 (resolution action: keep shared) | `Learning resources/Relay/src/Document.ts:375-388` (`save`/`requestSave`) | The 2-second debounced disk write; on `use-shared` resolution, project Y.Text to disk via this path. |
| Task 3 (browser conflict UI — banner) | `Learning resources/Relay/src/y-codemirror.next/LiveEditPlugin.ts:82-114` | The "Merge conflict — click to resolve" embed banner that opens the diff view. Lift the pattern; replace the Obsidian `EmbedBanner` with a React component. |
| Task 3 (side-by-side diff layout) | `Learning resources/Relay/src/differ/differencesView.ts` | The two-column diff renderer. Replace Obsidian DOM helpers with React/JSX. |
| Task 3 (hunk action lines) | `Learning resources/Relay/src/differ/actionLine.ts` + `actionLineButton.ts` + `actionLineDivider.ts` | "Use local hunk" / "use shared hunk" action buttons. Even if v1 ships file-level resolution only, lifting these now sets up hunk-level for a later upgrade. |
| Task 3 (file-level diff state) | `Learning resources/Relay/src/differ/fileDifferences.ts` and `difference.ts` | Internal hunk data model. |
| Task 3 (string diff helpers) | `Learning resources/Relay/src/differ/stringUtils.ts` | Utility functions. Lift verbatim. |
| Task 4 (native conflict UI) | Same `differ/` files | Render the same hunk model in SwiftUI/AppKit. Share the diff *computation* via a TypeScript package or reimplement in Swift. |
| Task 5 (CLI conflict JSON) | (no learning-resource reference) | Original. Surface the conflict state from Task 1 as JSON for agents. |

---

## Scope

This plan does not add AI-assisted merge or hunk-level merge. It ships the simple Relay-like choices: keep shared, accept local, or paste resolved content.

## Provider Runtime Facts From Plan 1B

- Provider restart durability is now covered by `apps/api/src/provider/ysweet-provider-smoke.ts`, which writes 200 updates, gracefully restarts the API-supervised Y-Sweet 0.9.1 child process, and verifies restored `Y.Text("contents")`.
- Reconnect/conflict E2E should run against the same root-mounted provider document routes used by production process mode (`/d/<providerDocId>/ws/<providerDocId>`, `/d/<providerDocId>/as-update`, `/d/<providerDocId>/update`), not a direct child-process port.
- `/healthz` already verifies provider `/ready`, authenticated `/check_store`, and required provider schema tables/columns; conflict smokes can treat a healthy response as the provider/control-plane readiness gate.

## Control Plane Facts From Plan 2

- Hosted `/collab` websocket bypasses are closed outside local/dev-anonymous mode. Conflict E2E must use the control-plane session route and Y-Sweet `ClientToken`, not legacy relay/websocket shortcuts.
- Edit refresh denial is the revocation/role-downgrade enforcement point. The API returns explicit errors such as `grant_revoked`, `grant_expired`, `provider_token_revoked`, `forbidden`, and `collab_session_not_found`; browser/native conflict UI should surface these as unavailable, not as merge conflicts.
- Guest edit quota is enforced only on new guest edit sessions. Existing guest edit sessions can refresh after grant/session/role/expiry/revocation checks, so reconnect tests should not expect quota exhaustion to evict already-active guest sessions.
- View links and read-only export/read routes do not receive provider credentials and must not create durable version rows. Conflict tests must not rely on view/read/export calls to checkpoint shared state.

## Browser Facts From Plan 3

- `apps/collab-web` now owns the browser editor shell. Edit links open `/collab?docId=...&branchId=...&token=...&mode=edit`; view links use the same route with `mode=view`.
- Browser edit mode already has unavailable-state handling for revoked view links, edit-session creation denials, provider-token revocation, and role downgrade during refresh. Conflict UI must not reinterpret those denial states as merge conflicts.
- Browser E2E now includes a real API-root Y-Sweet websocket smoke for two browser edit tabs, plus a faster memory-provider reconnect test for queued local edits. This plan still needs the full reconnect/conflict matrix against provider restart, disk projection, native/browser combinations, and conflict payloads.
- The browser editor has no conflict banner or conflict-resolution UI yet; Task 3 should add that UI inside the existing `apps/collab-web` editor shell rather than creating a new browser app.

## Native Facts From Plans 4 And 5.5

- Native source now lives in this monorepo at `apps/marklab-macos/` as a SwiftPM package using a Port MarkEdit UI shell strategy. The app owns a MarkEdit-derived document shell, bundled CodeMirror-in-WebKit local editor surface, share UI, native conflict inspector, hosted collaboration WKWebView bridge, local daemon client, and app-owned daemon registry format.
- The first native collaboration editor embeds the hosted `/collab` CodeMirror/Yjs app with `clientKind=app`; it does not yet ship a fully bundled native Yjs runtime. Shared browser/native editor semantics live in `packages/collab-editor/` and should be reused by browser conflict UI.
- The app editor URL is first-party and grantless. Public edit/view access grants are collaborator links only. The WKWebView injects `Authorization: Bearer ml_user_...` and `X-MarkLab-Native-App: 1` only into same-origin `/api/` fetches; the API downgrades app kind unless that authenticated native marker resolves to a non-guest actor.
- MarkLab.app watches the opened shared file with a macOS file-system dispatch source and also runs a timer fallback. One-sided disk changes are sent back into the embedded Y.Text editor only if live provider text still matches the expected baseline. Divergent disk/shared changes already open the native conflict surface.
- Native projection baselines are durable before in-memory advancement and store the full tuple: `lastProjectedMarkdown`, `lastProjectedHash`, `lastProviderStateFingerprint`, and `updatedAt`. The hosted-WKWebView MVP uses explicit `provider-ytext:sha256:...` fingerprints, not binary Yjs state fingerprints.
- After sharing, the app starts or reuses the local daemon boundary with `marklab share --json --daemon-only` and loads `/api/local/app-context`; this must not create a hidden local relay edit grant.
- Native smoke command: `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser`. It proves app-kind/browser convergence, disk projection, MarkEdit shell strategy, Swift build/runtime gates, and bidirectional cursor awareness, but it does not launch a GUI WKWebView automation harness. Keep that limitation explicit when expanding the conflict/reconnect matrix.

## File Structure

- Modify `apps/api/src/local/local-conflict-store.ts`
- Modify `apps/api/src/local/local-conflict-routes.ts`
- Modify `apps/api/src/local/local-file-service.ts`
- Modify `apps/api/src/local/local-conflict-store.test.ts`
- Modify `apps/api/src/routes/local-conflict-routes.test.ts`
- Modify `apps/collab-web/src/` conflict UI files created in `2026-05-11-collab-web-app.md`.
- Modify native conflict UI files created in `2026-05-11-marklab-native-integration.md`.
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
  - browser offline, local edits queue, reconnect flushes through the real provider route;
  - host offline, browser edit, host returns with disk unchanged;
  - host offline, browser edit, local disk edit, conflict opens;
  - native hosted-WKWebView app edit, browser edit, local disk edit, conflict opens using the Plan 4 `provider-ytext:sha256:...` baseline tuple;
  - grant revoked, token refresh denied;
  - role downgrade, token refresh denied without opening a merge conflict;
  - guest quota exhausted blocks a new guest edit session but does not evict an already-active guest refresh;
  - view link never connects to provider;
  - provider child process restart, client reconnects through API-root provider routes, no data loss;
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
  - `docs/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "conflict|lastProjectedMarkdown|use shared|accept local|offline|reconnect|revoked" docs/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after conflict hardening"`.
