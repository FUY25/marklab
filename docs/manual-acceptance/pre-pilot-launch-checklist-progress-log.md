# Pre-Pilot Launch Checklist And Progress Log

Date created: 2026-05-21

Purpose: track the minimum gates before MarkLab invites real pilot users. This is not a public-launch plan and not a full paid-billing launch plan. It is the working control document for moving from the current native relay implementation to a small, controlled pilot.

Target launch mode: small external pilot, initially 3-10 users, then 10-50 users only after the gates below pass.

Current product path under test:

- Native app: `apps/marklab-macos`
- Browser collaborator app: `/collab` served from the hosted API origin
- API/control plane: `/api/*`
- Provider: API-supervised Y-Sweet process, proxied under `/d/<providerDocId>/...`
- Metadata database: Neon Postgres
- Provider persistence: Fly volume `marklab_ysweet_data` mounted at `/data`, with store path `/data/ysweet`
- Archived local daemon path: compatibility-only, disabled by default

## Status Values

- `Not started` - no current evidence.
- `In progress` - actively being worked.
- `Blocked` - cannot complete until a named issue is fixed.
- `Passed` - evidence recorded in this document or linked docs.
- `Deferred` - explicitly not required for the small pilot.

## Launch Rule

Do not invite external pilot users until Gates 0-8, including Gate 2.5, are either `Passed` or explicitly marked `Deferred` with a reason and owner.

Do not enable paid billing until Gate 11 is `Passed`.

Do not publish website/video broadly until Gates 0-10 are `Passed` or the website/video clearly labels the product as private pilot. Gate 9.5 is allowed to remain deferred for private pilot, but must be completed before broader beta or public launch.

## Gate Summary

| Gate | Area | Status | Owner | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Release candidate freeze | Passed | TBD | Patched RC code commit `cf3a2691a3601e946d01f3cfb3b67789ce08f31b` passed the Gate 0 baseline. |
| 1 | Manual pilot acceptance | Passed | TBD | Phases 1-5 passed on patched RC; no open P0/P1 after P1-001 fix; P2 follow-ups logged. |
| 2 | P0/P1 blocker fix pass | Passed | TBD | P1-001 fixed, verified, and re-frozen into the patched RC. |
| 2.5 | Dead code inventory and safe removal | Not started | TBD | |
| 3 | Server/data lifecycle audit | Not started | TBD | |
| 4 | Cost instrumentation and unit economics | Not started | TBD | |
| 5 | Clean install and distribution | Not started | TBD | |
| 6 | Login, onboarding, workspace UI | Not started | TBD | |
| 7 | Security, privacy, and ops gate | Not started | TBD | |
| 8 | Public docs cleanup and old approach archive | Not started | TBD | |
| 9 | Small external pilot | Not started | TBD | |
| 9.5 | Post-pilot active-code simplification | Deferred | TBD | Wait for real pilot findings. |
| 10 | Brand, website, and video | Not started | TBD | |
| 11 | Paid billing and pricing launch | Deferred | TBD | Not required for small free pilot. |

## Gate 0 - Release Candidate Freeze

Goal: pick one commit SHA as the candidate under test so acceptance evidence and bugs refer to a stable build.

Checklist:

- [x] Record `git rev-parse HEAD`.
- [x] Record current branch.
- [x] Confirm worktree is clean or list intentional uncommitted changes.
- [x] Run the baseline automated commands selected for this RC:
  - [x] `npx -y pnpm@10.0.0 typecheck`
  - [x] `npx -y pnpm@10.0.0 test`
  - [x] `swift test --package-path apps/marklab-macos`
  - [x] `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app`
  - [x] `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package`
- [x] Build or identify the exact app artifact that pilot testers will use.
- [x] Create a `bug.md` section for this RC.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. No RC selected yet. | This document. | Select RC SHA. |
| 2026-05-21 | Gate passed. RC selected on `macos-app` at `c1333b4e7a3a0d47ec6db2269bd97638b27de124`; `origin/macos-app` matched local HEAD after fetch. Worktree is intentionally not clean only because this checklist file is still untracked. | `git status -sb`; `git rev-list --left-right --count HEAD...origin/macos-app` returned `0 0`; baseline commands below passed; `bug.md` RC section. | Start Gate 1 manual pilot acceptance. |
| 2026-05-21 | Baseline passed: TypeScript typecheck, full Vitest suite, Swift native tests, app packaging, and packaged app verification. | `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 test` reported 80 files passed, 682 tests passed, 1 skipped; `swift test --package-path apps/marklab-macos` reported 72 tests passed; `package:app`; `verify:package`. | Use `/Users/fuyuming/Desktop/markdown_ai_collab_milkdown_spec/dist/MarkLab.app` as the Gate 1 candidate artifact. |
| 2026-05-21 | Gate re-frozen after P1-001 fix. Patched RC code commit is `cf3a2691a3601e946d01f3cfb3b67789ce08f31b`. | `swift test --package-path apps/marklab-macos` reported 73 tests passed; `npx -y pnpm@10.0.0 typecheck` passed; `npx -y pnpm@10.0.0 test` reported 80 files passed, 682 tests passed, 1 skipped; `package:app`; `verify:package`; Phase 2.2 re-run passed. | Resume Gate 1 Phase 2.3 cursor/presence checks. |

Exit criteria:

- One commit SHA and one app artifact are named as the RC.
- Later bug reports use that SHA/artifact unless the RC is deliberately replaced.

## Gate 1 - Manual Pilot Acceptance

Goal: run the manual acceptance matrix against the RC, not against a moving branch.

Primary docs:

- Setup runbook: [`new-relay-pilot.md`](./new-relay-pilot.md)
- Acceptance script: [`pilot-acceptance-checklist.md`](./pilot-acceptance-checklist.md)

Checklist:

- [x] Confirm `/healthz` is green for the target origin.
- [x] Seed or identify one pilot owner session and workspace id.
- [x] Seed or create one edit link and one view link.
- [x] Run Phase 1 smoke.
- [x] Run Phase 2 convergence and presence.
- [x] Run Phase 3 permissions and lifecycle.
- [x] Run Phase 4 edge cases.
- [x] Run Phase 5 native polish.
- [x] Append final acceptance summary to `bug.md`.
- [x] Classify every finding as P0, P1, P2, or deferred.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Manual pass not started. | Existing manual checklist. | Run pre-flight after RC freeze. |
| 2026-05-21 | Gate started for RC `c1333b4e7a3a0d47ec6db2269bd97638b27de124`; hosted health preflight passed. | `curl -fsS https://marklab-relay-alpha.fly.dev/healthz \| jq .` returned `ok: true`, database ready, schema missing `[]`, provider ready, store ready. | Seed or identify one pilot owner session and workspace id. |
| 2026-05-21 | Existing `.env.marklab-pilot` identified a pilot owner token, workspace id, pilot doc/branch, edit URL, and view URL. Authenticated smoke passed against the hosted origin. | `MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 node scripts/marklab-alpha-smoke.mjs` with env from `.env.marklab-pilot` returned `ok: true`, manual billing `planId: dev`, `memberSeats: 1000`, `concurrentGuestEdits: 1000`. | Run Phase 1 smoke. |
| 2026-05-21 | Existing edit and view grants accepted by the control plane. Edit session issued a provider token; view session created a rendered snapshot session and did not issue a provider token. | Redacted `POST /api/docs/:docId/branches/:branchId/collab/session` checks for `mode=edit` and `mode=view`. | Run Phase 1.1 and Phase 1.2 in browser. |
| 2026-05-21 | Phase 1.1 and 1.2 browser checks passed in headless Chromium. Edit link mounted CodeMirror, accepted typed text, opened provider websocket, and created IndexedDB. View link rendered Markdown, mounted no CodeMirror editor, opened no provider websocket, and created no IndexedDB. | Redacted Playwright check against `.env.marklab-pilot` edit/view URLs returned `ok: true`, zero console errors, zero page errors. | Run Phase 1.3 and 1.4 native app checks. |
| 2026-05-21 | Phase 1 smoke passed. RC artifact launched `pilot.md`; native accessibility tree showed the MarkEdit shell with ToC, Heading, Bold/Italic, List, Document, and Collaboration toolbar controls; local edit was saved to disk and preserved the expected trailing LF; hosted health stayed green after smoke. | `/Users/fuyuming/Desktop/markdown_ai_collab_milkdown_spec/dist/MarkLab.app`; `~/marklab-pilot-acceptance/pilot.md`; disk check reported `endswith_acceptance_lf: true`; `/healthz` returned `ok: true`, database/schema/provider/store ready. | Run Phase 2 convergence and presence. |
| 2026-05-21 | Phase 2.1 browser-to-browser convergence passed. Two isolated Chromium contexts opened the same edit grant, each received the other's typed marker, and the final cleaned editor text matched exactly on both sides. | Redacted Playwright check reported 2 provider websockets, zero console errors, zero page errors, final text length 322 on both sides, matching hash `d0a14397be2f`. | Run Phase 2.2 app-to-browser convergence. |
| 2026-05-21 | Phase 2.2 found P1-001. Native app entered shared mode, created an edit link, browser collaborator joined, app marker appeared in browser, and browser marker appeared in app. However, the local `pilot.md` file did not receive either marker after the shared projection debounce, after an additional wait, or after Cmd+S. | RC app pid 9028; redacted browser collaborator check returned `ok: true`, `appMarkerSeen: true`, `browserMarkerTyped: true`; app accessibility tree showed both markers; disk check stayed at 56 bytes and did not contain either marker after 10+ seconds or Cmd+S. | Stop Gate 1 full pass and move P1-001 into Gate 2. |
| 2026-05-21 | Phase 2.2 re-run passed after P1-001 fix. Native app entered shared mode from a clean scratch file, created a browser edit link, app marker appeared in browser, browser marker appeared in app, selection status updated from the native bridge, and both app/browser markers projected to the local `.md` file. | Patched `/Users/fuyuming/Desktop/markdown_ai_collab_milkdown_spec/dist/MarkLab.app`; `~/marklab-pilot-acceptance/pilot-bridge-fix.md` contained `from app bridge fixed 1779366352` and `browser-ok-2` after the shared projection debounce; Playwright browser check saw provider websocket and zero errors. | Resume Phase 2.3 cursor/presence checks on patched RC `cf3a2691a3601e946d01f3cfb3b67789ce08f31b`. |
| 2026-05-21 | Phase 2.3 visual cursor/presence passed with one P2 follow-up. Browser-to-browser, app-to-browser, and browser-to-app cursor/selection rendering were visually confirmed. Anchor stability was confirmed on the non-editing observer surface: the collaborator cursor moved with the text after insertion. The actively editing browser/app surfaces showed delayed remote-cursor re-anchor until the next refresh/awareness update; this is P2-002, not a pilot blocker. | User manual visual check: Phase 2.3 items 1-6 passed; anchor observer moved correctly; active editor surfaces lagged before refreshing. Extra headless collaborator was connected for the anchor test, then stopped. Supporting screenshots: `/tmp/marklab-phase23-app-selection.png`, `/tmp/marklab-phase23-browser-after-app.png`. | Continue Phase 2.4 cursor disappears on disconnect. |
| 2026-05-21 | Phase 2.4 cursor disappears on disconnect passed. Closing the extra collaborator removed its remote cursor/label from the remaining browser and MarkLab.app surfaces within the acceptable window. | User manual visual check reported pass. | Continue Phase 2.5 awareness identity sanitization. |
| 2026-05-21 | Phase 2.5 awareness identity sanitization passed. A scripted edit-capable provider client joined with display name `<script>alert(1)</script>` while a headless Chromium observer watched the real edit grant. The observer rendered the malicious name as literal text in both the presence strip and remote cursor label. | Redacted scripted check returned `ok: true`, `presenceText` containing the literal malicious name, `labelText` equal to the literal malicious name, `dialogs: 0`, `scriptElements: 0`, `htmlHasInjectedScript: false`, `consoleErrors: 0`, `pageErrors: 0`. | Continue Phase 2.6 disk projection debounce. |
| 2026-05-21 | Phase 2.6 disk projection debounce passed. Rapid typing in MarkLab.app did not update the file on every keystroke, stopped typing projected to disk within the expected debounce window, Cmd+S flushed immediately, and an external append was ingested back into both MarkLab.app and the browser edit surface. | User manual visual/file check reported pass. | Continue Phase 3.1 edit link refresh. |
| 2026-05-21 | Phase 3.1 edit link refresh passed. A headless Chromium edit session used the real hosted edit grant and a forwarded session-create response with a shortened `expiresAt` to trigger refresh immediately. The app sent `POST /provider-token/refresh`, received 200, stayed connected, and accepted edits before and after refresh. A fresh verification browser saw both markers. | Scripted check returned `ok: true`, `refreshStatus: 200`, `reconnectSamples: 0`, `reconnectSpanMs: 0`, `consoleErrors: 0`, `pageErrors: 0`, `requestFailures: 0`; verification browser saw `phase31-refresh-1779369793455-before` and `phase31-refresh-1779369793455-after`. | Continue Phase 3.2 revoked edit link lifecycle. |
| 2026-05-21 | Phase 3.2 revoked edit link lifecycle passed. A disposable edit access grant was created on the pilot doc, opened in headless Chromium, then revoked through the authenticated API before the shortened refresh window. The editor accepted local typing before refresh, then the refresh returned 403 `grant_revoked`, the UI showed Unavailable, and post-revocation typing did not modify content. | Disposable grant `ba276bb3-0a02-4441-96d2-cb5061487dcf`; scripted check returned `revokeStatus: 204`, `refreshStatus: 403`, `refreshBodyIncludesGrantRevoked: true`, `unavailableText: grant_revoked`, `postTypingBlocked: true`, `pageErrors: 0`, `requestFailures: 0`; one console error was the expected 403 resource log. | Continue Phase 3.3 revoked view link. |
| 2026-05-21 | Phase 3.3 revoked view link passed. A disposable view access grant rendered the pilot doc in view-only mode, then was revoked through the authenticated API. Reloading the same URL showed an unavailable/forbidden state and did not mount an editor or provider websocket. | Disposable grant `e3f2cf30-7d73-46e2-99f2-367dc7f1269e`; scripted check returned `initialViewRendered: true`, `renderedLength: 393`, `revokeStatus: 204`, `reloadUnavailableText: forbidden`, `editorCount: 0`, `providerWebsockets: 0`, `pageErrors: 0`; one console error was the expected denied session fetch. | Continue Phase 3.4 role downgrade. |
| 2026-05-21 | Phase 3.4 role downgrade passed. A disposable edit access grant was opened, then downgraded to `view` through a scoped SQL update by grant id. On the next shortened refresh, the editor received 403 `forbidden`, transitioned to Unavailable, did not show any conflict state, and blocked further typing. The disposable grant was revoked after the check. | Disposable grant `ef2c5b37-20a1-40c5-99fb-7aefdc3f399a`; scripted check returned `roleAfterSql: view`, `refreshStatus: 403`, `refreshBodyIncludesForbidden: true`, `unavailableText: forbidden`, `noConflictUi: true`, `postTypingBlocked: true`, `pageErrors: 0`; one console error was the expected 403 resource log. | Continue Phase 3.5 guest quota. |
| 2026-05-21 | Phase 3.5 guest quota was skipped for this pilot workspace. The current manual/dev plan has a high alpha cap, so exhausting quota would require opening 1001 concurrent guest edit sessions and is not a useful small-pilot gate. Low-quota enforcement should be tested in a dedicated billing/usage workspace before paid launch. | `MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 node scripts/marklab-alpha-smoke.mjs` returned `planId: dev`, `memberSeats: 1000`, `concurrentGuestEdits: 1000`, with health/schema/provider/store ready. | Continue Phase 3.6 native bearer spoof check. |
| 2026-05-21 | Phase 3.6 native bearer spoof check passed. A disposable public edit link was opened in a regular browser with `clientKind=app` manually appended. The browser still sent `clientKind: browser`, the server returned `session.clientKind: browser`, and the page mounted the normal browser shell rather than the native shell. | Disposable grant `a46f958a-90e1-446c-abd9-06e9f7d3c419`; scripted check returned `sessionStatus: 201`, `urlParamClientKind: app`, `requestClientKind: browser`, `responseClientKind: browser`, `nativeFlag: false`, `shellClass: collab-shell`, `browserTopbarVisible: true`, `previewPaneVisible: true`, `consoleErrors: 0`, `pageErrors: 0`. | Continue Phase 4.1 host app offline/reconnect. |
| 2026-05-21 | Phase 4.1 guest editing while host app is offline passed. Browser collaborator continued editing while MarkLab.app was quit. Reopening MarkLab.app on the same local file caught up with the browser edits, and the local file contained the expected `phase41` markers. | User manual visual/file check reported pass; local verification used `rg "phase41" ~/marklab-pilot-acceptance/pilot-presence-phase23.md`. | Continue Phase 4.2 browser offline/reconnect. |
| 2026-05-21 | Phase 4.2 browser offline/reconnect passed. Two isolated browser contexts opened a disposable edit grant. Browser A went offline, showed Offline/Reconnecting, accepted five local edits, and had the expected `marklab:collab-web:*` IndexedDB database. After Browser A returned online, it became Connected and Browser B received all five offline edits exactly once. | Disposable grant `be3de935-76a5-4758-a89b-004189ba37bc`; scripted check returned `offlineStatusObserved: true`, `indexedDbMatched: true`, `observerSawAllLines: true`, `duplicateLines: 0`, `pageAConnectedAfterReconnect: true`, `pageBConnected: true`, `pageErrorsA: 0`, `pageErrorsB: 0`; Browser A had expected offline network console errors. | Continue Phase 4.3 missing local file projection pause. |
| 2026-05-21 | Phase 4.3 missing local file projection pause passed with P2-003. When the local file was moved aside, MarkLab.app showed `Unable to ingest local disk change.` instead of silently recreating or overwriting the missing file. Browser edits continued, the app remained usable, and state reconciled after the file was restored. The error status was visually too neutral, so P2-003 tracks making projection failures red/more prominent. | User manual visual/file check with screenshot; `phase43` browser edits stayed visible and the restored local file reconciled. `bug.md` P2-003 records the neutral error styling follow-up. | Continue Phase 4.4 disk/provider divergence conflict UI. |
| 2026-05-21 | Phase 4.4 disk/provider divergence conflict UI passed with P2-004. The native conflict panel appeared after disk and provider diverged, showed local/shared/base content, rendered a non-empty diff, exposed Accept Local, Keep Shared, and Paste Resolved controls, and the functional conflict behavior passed. The conflict review UI is cramped because it is embedded in the same sidebar as collaboration metadata and active collaborators, so P2-004 tracks a dedicated conflict review surface. | User manual visual/functional check with screenshot; `bug.md` P2-004 records the sidebar conflict review UI follow-up. | Continue Phase 4.5 paste-resolved confirmation guard. |
| 2026-05-21 | Phase 4.5 paste-resolved confirmation guard passed. The resolved-content action stayed guarded against empty content, wrong confirmation text, and single-click publishing; it only became available when resolved Markdown was non-empty and the confirmation string matched `APPLY RESOLVED`. | User manual functional check reported pass. | Continue Phase 4.6 external atomic save during conflict. |
| 2026-05-21 | Phase 4.6 external atomic save during conflict passed. While a conflict was open, the local file was externally atomically replaced with `external atomic replacement phase46`. Resolving the conflict did not silently overwrite that newer local file; the replacement remained visible. The prior file contents disappearing was expected because the test performed a full-file replacement, not an append or merge. | User manual visual/file check reported the external atomic replacement remained visible after resolution. | Continue added Phase 4.7/4.8 agent local edit/replace smoke before Phase 5 native polish. |
| 2026-05-21 | Phase 4.8 agent atomic replace during active user typing passed. While the user typed continuously in the shared editor, an external simulated agent first appended to disk and then performed a blind atomic full-file replacement. MarkLab.app opened an explicit conflict instead of silently choosing a winner. The conflict UI separated `Local disk` as `AGENT DIRECT REPLACE DURING ACTIVE TYPING phase48 ...` and `Shared editor` as the user's active typing, with a non-empty diff. | User manual visual check with screenshot; local disk was `AGENT DIRECT REPLACE DURING ACTIVE TYPING phase48 2026-05-21T14:38:32Z`, and the native conflict panel showed both local and shared sides. | Resolve current conflict, then decide whether to run the lower-risk Phase 4.7 normal agent local edit/replace smoke or continue to Phase 5. |
| 2026-05-21 | Phase 5 native shell polish passed. Window metrics, toolbar layout, operational status pills, and shared-mode MarkEdit-shell parity passed manual visual review. The separate Phase 4.7 normal agent local edit/replace smoke was not run as its own row because external append was already covered in Phase 2.6 and during Phase 4.8, while the higher-risk blind atomic replace race was covered in Phase 4.8. | User manual visual check reported `5.1-5.4` passed. Final manual acceptance summary appended to `bug.md`; all findings classified. | Gate 1 passed. Continue Gate 2.5 dead code inventory and safe removal before server/data lifecycle work. |

Exit criteria:

- Manual checklist has a written result.
- P0 and P1 findings are listed in Gate 2.
- P2 findings are either accepted as known limitations or scheduled after pilot.

## Gate 2 - P0/P1 Blocker Fix Pass

Goal: fix only the issues that block a small pilot. Avoid endless scope expansion.

Severity definitions:

- `P0` - data loss, permission leak, cannot install/open/share/join, or cannot recover from sync/conflict failure.
- `P1` - core user journey works only with manual workaround or confusing error state.
- `P2` - polish, non-critical edge case, or post-pilot quality improvement.

Checklist:

- [x] Copy P0/P1 findings from `bug.md`.
- [x] For each P0/P1, assign owner and target fix.
- [x] Add or update automated regression tests where practical.
- [x] Re-run the smallest relevant test suite for each fix.
- [x] Re-run full Gate 0 baseline if the fixes touch shared sync/auth/storage behavior.
- [x] Re-run affected manual acceptance rows.

Progress log:

| Date | Finding | Priority | Status | Evidence |
| --- | --- | --- | --- | --- |
| 2026-05-21 | P1-001: shared-mode app/browser edits are visible in the native hosted editor but do not project to the local Markdown file. | P1 | Fixed | Cause: native WebView message origin check rejected default HTTPS origins when `WKSecurityOrigin.port` was reported as `0`; fix normalizes omitted ports to the scheme default while preserving custom-port rejection. Verified with Swift test, package verification, typecheck, full Vitest suite, and manual Phase 2.2 re-run. |

Exit criteria:

- No open P0.
- No open P1 without an explicit pilot workaround and user-facing known limitation.

## Gate 2.5 - Dead Code Inventory And Safe Removal

Goal: remove or quarantine old implementation paths only after the RC has been manually exercised and P0/P1 findings are understood. This gate reduces codebase confusion without changing the active pilot behavior.

Timing:

- Start after Gate 2 is passed or after Gate 2 has no cleanup-blocking P0/P1 findings.
- Finish before Gate 3 so server/data lifecycle work does not keep paying attention to dead paths.
- Do not use this gate for broad active-path refactors.

Classification:

- `Delete now` - no active import, package script, route, build target, test target, or current doc reference.
- `Archive only` - historically useful, but must not participate in build, test discovery, product docs, or pilot setup.
- `Keep temporarily` - still referenced by compatibility code, docs, scripts, tests, or a launch fallback.
- `Simplify later` - active code that may be too complex, but should wait for pilot evidence unless it is blocking a P0/P1 fix.

Checklist:

- [ ] Create an inventory table of old approach candidates:
  - [ ] local daemon code;
  - [ ] old `/relay` or `/local` routes;
  - [ ] old host-gated local sync tests;
  - [ ] disabled Playwright specs;
  - [ ] stale scripts;
  - [ ] stale docs outside `docs/Archive`;
  - [ ] unused package scripts;
  - [ ] unused fixtures or generated artifacts.
- [ ] For every candidate, record:
  - [ ] path;
  - [ ] classification;
  - [ ] current references from `rg`;
  - [ ] decision;
  - [ ] owner;
  - [ ] rollback note.
- [ ] Verify active references before deletion:
  - [ ] TypeScript imports;
  - [ ] Swift package targets;
  - [ ] Node package exports;
  - [ ] `package.json` scripts;
  - [ ] CI/test commands;
  - [ ] app route registration;
  - [ ] CLI entrypoints;
  - [ ] README/current docs.
- [ ] Delete only `Delete now` candidates.
- [ ] Move or mark `Archive only` candidates so they are not discovered by test/build tooling.
- [ ] Leave `Keep temporarily` candidates in place with a short TODO or tracking note if their status is confusing.
- [ ] Do not change the active pilot path:
  - [ ] native app open/share/join;
  - [ ] `/collab`;
  - [ ] `/api/*`;
  - [ ] provider proxy under `/d/<providerDocId>/...`;
  - [ ] Neon schema;
  - [ ] Fly Y-Sweet persistence.
- [ ] Re-run baseline checks after cleanup:
  - [ ] `npx -y pnpm@10.0.0 typecheck`
  - [ ] `npx -y pnpm@10.0.0 test`
  - [ ] `swift test --package-path apps/marklab-macos`
  - [ ] package verification if package scripts or native app files changed.

Progress log:

| Date | Candidate/Area | Decision | Evidence | Next |
| --- | --- | --- | --- | --- |
| 2026-05-21 | Gate created. No inventory yet. | Not started | This document. | Run inventory after Gate 2. |

Exit criteria:

- All old-path candidates are classified as `Delete now`, `Archive only`, `Keep temporarily`, or `Simplify later`.
- Any deleted code has evidence that no active build/test/runtime/doc path still references it.
- The active pilot flow behaves the same after cleanup.
- Full baseline is green, or any failure is understood and unrelated.

## Gate 3 - Server/Data Lifecycle Audit

Goal: know exactly what lives locally, what lives in cloud storage, how long it stays, and how it is deleted or recovered.

Current known storage model:

- Local `.md` file remains the user's local working copy.
- Neon Postgres stores users, sessions, workspaces, workspace membership, documents, branches, access grants, collab sessions, token issuance metadata, versions, and billing/seat-limit metadata.
- Fly volume stores Y-Sweet provider document state under `/data/ysweet`.
- Fly volume snapshots are useful recovery support, but must not be treated as the only backup for important data.

Checklist:

- [ ] Create a storage map: local file, app support files, Neon tables, Fly volume paths, logs, generated artifacts.
- [ ] Define document lifecycle:
  - [ ] local-only file;
  - [ ] Start Sharing;
  - [ ] active shared document;
  - [ ] Stop Sharing;
  - [ ] document deletion;
  - [ ] workspace/account deletion.
- [ ] Define retention policy:
  - [ ] access grants;
  - [ ] access sessions;
  - [ ] collab sessions;
  - [ ] provider token issuances;
  - [ ] versions/snapshots;
  - [ ] provider documents;
  - [ ] logs.
- [ ] Define deletion semantics:
  - [ ] revoke link;
  - [ ] Stop Sharing;
  - [ ] delete cloud document;
  - [ ] delete workspace;
  - [ ] delete account;
  - [ ] local file missing/deleted.
- [ ] Define backup/restore:
  - [ ] Neon backup/restore;
  - [ ] Fly volume snapshot/fork restore;
  - [ ] provider-state restore test;
  - [ ] RPO/RTO for alpha.
- [ ] Define cleanup jobs needed before/after pilot:
  - [ ] expired grants;
  - [ ] expired sessions;
  - [ ] stale provider token rows;
  - [ ] inactive provider docs;
  - [ ] old version snapshots.
- [ ] Update public privacy/storage wording if policy differs from existing docs.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Current storage model recorded from existing launch docs. | `fly.toml`, `alpha-launch-runbook.md`, `privacy-and-storage.md` | Write lifecycle policy draft. |

Exit criteria:

- A lifecycle/retention/deletion policy exists and matches implementation or clearly names gaps.
- A restore drill is documented or scheduled before inviting more than 10 users.
- Public docs do not overpromise local-only or cloud deletion behavior.

## Gate 4 - Cost Instrumentation And Unit Economics

Goal: collect enough usage data to price the product without guessing.

Known cost centers:

- Fly compute for the always-on API/provider machine.
- Fly volume provisioned storage and snapshots.
- Fly data egress.
- Neon compute CU-hours.
- Neon database and history storage.
- Payment processing fees, once billing is enabled.
- Support time.

Checklist:

- [ ] Add or run a usage-report script that can summarize by workspace:
  - [ ] active documents;
  - [ ] provider document count;
  - [ ] estimated provider store bytes;
  - [ ] Markdown bytes;
  - [ ] version snapshot bytes;
  - [ ] collab session minutes;
  - [ ] guest edit session count;
  - [ ] provider token refresh count;
  - [ ] API request count if available;
  - [ ] estimated egress if available;
  - [ ] last active time.
- [ ] Record current Fly bill/cost explorer snapshot.
- [ ] Record current Neon usage snapshot.
- [ ] Estimate pilot cost per active workspace at p50/p90/p99.
- [ ] Define free alpha caps:
  - [ ] max workspaces;
  - [ ] max active shared docs;
  - [ ] max collaborators;
  - [ ] max provider storage;
  - [ ] max version retention;
  - [ ] inactivity TTL.
- [ ] Build pricing model:
  - [ ] fixed infra cost;
  - [ ] variable infra cost;
  - [ ] support cost;
  - [ ] payment fee;
  - [ ] target gross margin;
  - [ ] no-loss floor.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. No usage meter/report is recorded here yet. | Existing cost discussion. | Inventory what usage data is already queryable from Neon/Fly. |

Exit criteria:

- We can answer "what does one active workspace cost per month?" with a measured range.
- Free alpha caps are explicit.
- Paid pricing is not implemented until this gate produces a no-loss floor.

## Gate 5 - Clean Install And Distribution

Goal: prove a non-developer user can install and use the app without the repo checkout.

Checklist:

- [ ] Package MarkLab.app from the RC.
- [ ] Install on a separate macOS user profile or separate Mac.
- [ ] Confirm app opens without Terminal.
- [ ] Confirm bundled editor resources load.
- [ ] Confirm local open/edit/save works.
- [ ] Confirm hosted login/session configuration works.
- [ ] Confirm Start Sharing creates a workspace-owned document.
- [ ] Confirm Create Edit Link and Create View Link work.
- [ ] Confirm `marklab share file.md --edit` works through MarkLab.app.
- [ ] Confirm app-to-app join works from an edit link.
- [ ] Confirm quit/reopen restores shared bindings.
- [ ] Record Gatekeeper/quarantine/signing/notarization behavior.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Existing automated package checks are not enough for this gate. | Plan 6 notes clean-install pass remains manual. | Run separate-user clean install after RC freeze. |

Exit criteria:

- Clean install pass is recorded.
- Any required installation workaround is documented before pilot.

## Gate 6 - Login, Onboarding, And Workspace UI

Goal: replace operator-token handoff with a real first-run path suitable for pilot users.

Checklist:

- [ ] Pick login strategy for small pilot:
  - [ ] OIDC;
  - [ ] invite-token bootstrap;
  - [ ] email magic link;
  - [ ] other.
- [ ] Define first-run native app flow:
  - [ ] unauthenticated state;
  - [ ] sign-in;
  - [ ] workspace select/create;
  - [ ] session persistence;
  - [ ] token refresh/expiry;
  - [ ] sign out.
- [ ] Define browser flow:
  - [ ] host/admin workspace settings;
  - [ ] edit link without login;
  - [ ] view link without login;
  - [ ] expired/revoked link.
- [ ] Implement or verify UI states:
  - [ ] missing workspace;
  - [ ] auth failure;
  - [ ] quota exceeded;
  - [ ] provider unavailable;
  - [ ] session expired.
- [ ] Update user guide with real login path.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Current broad-pilot caveat is that dev-login is disabled in production and operator token bootstrap is not a normal user path. | `README.md`, `alpha-launch-runbook.md` | Choose login strategy. |

Exit criteria:

- A pilot user can start without a developer manually exporting env vars.
- App and browser error states are understandable when auth/session/workspace is missing.

## Gate 7 - Security, Privacy, And Ops

Goal: reduce the main launch risks: permission leaks, raw token leaks, silent data loss, and unrecoverable deploy incidents.

Checklist:

- [ ] Verify view links do not mount editable provider sessions.
- [ ] Verify revoked edit links stop provider-token refresh and editing.
- [ ] Verify raw access/share/provider/session tokens are not logged.
- [ ] Verify CORS/origin rules match production origin.
- [ ] Verify public browser traffic cannot spoof native `clientKind=app`.
- [ ] Verify local file paths are treated as local/private context.
- [ ] Verify `/healthz` includes database, schema, provider, and provider store readiness.
- [ ] Verify Fly rollback command.
- [ ] Verify Neon schema migration command.
- [ ] Verify provider persistence restart smoke.
- [ ] Verify support/debug instructions do not ask users to paste raw tokens.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Several items have automated coverage, but this gate still needs a launch-specific evidence pass. | Existing bug log and tests. | Build security/ops evidence list from current tests. |

Exit criteria:

- Security/privacy/ops evidence is linked from this document.
- Any residual risk is written as a known limitation.

## Gate 8 - Public Docs Cleanup And Old Approach Archive

Goal: make public-facing docs describe only the current native relay/Y-Sweet path.

Checklist:

- [ ] Audit `README.md`.
- [ ] Audit `docs/product/*`.
- [ ] Audit `docs/agent/*`.
- [ ] Audit `docs/production/*`.
- [ ] Keep archived local-daemon docs clearly marked as historical.
- [ ] Remove or archive stale quickstarts that route users to old `/relay`, `/local`, host-gated, or daemon-first paths.
- [ ] Reflect Gate 2.5 decisions in public docs:
  - [ ] deleted old paths are not mentioned as usable;
  - [ ] archived old paths are clearly historical;
  - [ ] temporarily kept compatibility paths are not advertised as pilot setup.
- [ ] Confirm current docs explain:
  - [ ] install/open;
  - [ ] login/session;
  - [ ] Start Sharing;
  - [ ] edit/view links;
  - [ ] app collaborator join;
  - [ ] Stop Sharing;
  - [ ] known limitations.
- [ ] Decide whether any remaining compatibility code should move from `Keep temporarily` to `Delete now` after pilot.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Public docs already point mostly to native relay path, but a final stale scan is still required. | Existing README and docs. | Run stale wording scan after login/onboarding copy is final. |

Exit criteria:

- A new pilot user is not sent to the archived daemon path by public docs.
- Known limitations are honest and easy to find.

## Gate 9 - Small External Pilot

Goal: validate with real users after internal gates pass.

Checklist:

- [ ] Pick 3-10 pilot users.
- [ ] Confirm each user has:
  - [ ] compatible macOS version;
  - [ ] install artifact;
  - [ ] login path;
  - [ ] support contact;
  - [ ] known limitations.
- [ ] Define pilot success metric:
  - [ ] install success;
  - [ ] first local file open;
  - [ ] first share link created;
  - [ ] first collaborator join;
  - [ ] no data-loss incidents;
  - [ ] support time per user.
- [ ] Collect bugs in `bug.md`.
- [ ] Collect usage/cost data for Gate 4.
- [ ] Decide whether to expand to 10-50 users.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Not started. | | Wait for Gates 0-8, including Gate 2.5. |

Exit criteria:

- At least 3 real users complete the core flow.
- No unresolved P0.
- Expansion decision is written.

## Gate 9.5 - Post-Pilot Active-Code Simplification

Goal: simplify active code only after real pilot usage shows which complexity actually hurts shipping, support, reliability, or iteration speed.

Timing:

- Deferred during private pilot unless active-code complexity is directly causing a P0/P1 issue.
- Start after Gate 9 produces real bug/support/usage evidence.
- Complete before broader beta or public launch if the pilot exposes repeated support or reliability problems caused by code complexity.

Allowed before pilot:

- Small, behavior-preserving cleanup that is required by Gate 2.5.
- Refactors that directly fix a P0/P1 finding.
- Removing dead branches after references are proven stale.

Not allowed before pilot unless blocking:

- Rewriting sync/session/auth/storage boundaries.
- Renaming shared modules across native, API, and web in one pass.
- Changing provider lifecycle semantics.
- Replacing tested compatibility code with a new abstraction only for neatness.

Checklist:

- [ ] Review Gate 9 pilot findings and support notes.
- [ ] Identify the top code complexity drivers with evidence:
  - [ ] repeated bug source;
  - [ ] repeated support confusion;
  - [ ] slow release/test loop;
  - [ ] unclear ownership boundary;
  - [ ] duplicate implementation that caused divergence.
- [ ] Classify each simplification candidate:
  - [ ] must fix before beta;
  - [ ] nice to fix after beta;
  - [ ] leave alone.
- [ ] For each must-fix simplification:
  - [ ] define behavior that must not change;
  - [ ] write or identify regression coverage;
  - [ ] keep the write set narrow;
  - [ ] run focused tests;
  - [ ] run Gate 0 baseline if shared behavior changed.
- [ ] Update architecture docs only after the active code has changed.

Progress log:

| Date | Area | Decision | Evidence | Next |
| --- | --- | --- | --- | --- |
| 2026-05-21 | Gate created. Deferred until pilot evidence exists. | Deferred | This document. | Wait for Gate 9. |

Exit criteria:

- Any pre-beta simplification is tied to a real pilot finding or release-speed bottleneck.
- Behavior-preserving claims are backed by tests or manual acceptance rows.
- Architecture docs match the simplified code.

## Gate 10 - Brand, Website, And Video

Goal: create launch-facing assets only after the actual user path is stable.

Checklist:

- [ ] Pick final product name and logo.
- [ ] Record screenshots/video from the RC or later accepted build.
- [ ] Website first screen shows the real product, not a placeholder concept.
- [ ] Demo video shows:
  - [ ] open a local Markdown file;
  - [ ] Start Sharing;
  - [ ] create edit link;
  - [ ] browser collaborator joins;
  - [ ] local file updates;
  - [ ] conflict/safety message or known limitation if relevant.
- [ ] Website includes:
  - [ ] install path;
  - [ ] current platform support;
  - [ ] privacy/storage statement;
  - [ ] known limitations;
  - [ ] pilot signup/contact path.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Defer until user path is stable. | | Wait for Gates 0-9; complete Gate 9.5 before broader beta/public launch. |

Exit criteria:

- Website/video match the real pilot flow and do not promise features still deferred.

## Gate 11 - Paid Billing And Pricing Launch

Goal: enable billing only after measured unit economics prove prices will not lose money.

Checklist:

- [ ] Use Gate 4 data to set no-loss floor.
- [ ] Decide initial packaging:
  - [ ] free trial;
  - [ ] personal/pro;
  - [ ] team;
  - [ ] annual option.
- [ ] Decide billing provider and payment methods.
- [ ] Implement Stripe or chosen provider:
  - [ ] checkout;
  - [ ] customer portal;
  - [ ] webhooks;
  - [ ] cancellation;
  - [ ] failed payment;
  - [ ] plan mutation;
  - [ ] admin/support view.
- [ ] Verify payment processing fee impact.
- [ ] Verify quota/seat behavior per paid plan.
- [ ] Verify refund/cancellation policy.
- [ ] Update pricing page and terms.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Deferred for small free pilot. Pricing requires measured usage first. | Gate 4 pending. | Do not implement paid billing yet. |

Exit criteria:

- Paid plans are backed by real usage data and tested billing flows.
- No-loss floor and target margin are documented.

## Global Progress Log

Use this table for cross-gate updates.

| Date | Gate | Update | Evidence | Next |
| --- | --- | --- | --- | --- |
| 2026-05-21 | All | Created the pre-pilot launch control document. | This file. | Start Gate 0. |
| 2026-05-21 | 2.5, 9.5 | Added safe dead-code removal before lifecycle work and deferred active-code simplification until after pilot evidence. | Gate 2.5 and Gate 9.5 sections. | Keep cleanup evidence-driven. |
| 2026-05-21 | 2 | Fixed P1-001 native shared-mode disk projection failure and re-froze patched RC code commit `cf3a2691a3601e946d01f3cfb3b67789ce08f31b`. | `NativeHostedWebViewSecurity.swift`; `NativeHostedWebViewSecurityTests.swift`; Phase 2.2 re-run; Gate 0 baseline. | Continue Gate 1 Phase 2.3. |
| 2026-05-21 | 1 | Phase 2.3 cursor/presence visual pass completed with P2-002 logged for active-editor cursor re-anchor latency. | User manual visual check; extra headless collaborator; screenshots under `/tmp/marklab-phase23-*.png`. | Continue Phase 2.4 cursor disappears on disconnect. |
| 2026-05-21 | 1 | Phase 2.4 cursor disconnect visual pass completed. | User manual visual check. | Continue Phase 2.5. |
| 2026-05-21 | 1 | Phase 2.5 malicious awareness display name sanitization passed. | Scripted real-provider check with headless Chromium observer. | Continue Phase 2.6. |
| 2026-05-21 | 1 | Phase 2.6 disk projection debounce and external file watcher ingestion passed. | User manual visual/file check. | Continue Phase 3.1. |
| 2026-05-21 | 1 | Phase 3.1 edit link refresh transparency passed. | Scripted hosted refresh check with shortened client-side expiry and fresh-browser marker verification. | Continue Phase 3.2. |
| 2026-05-21 | 1 | Phase 3.2 revoked edit link lifecycle passed. | Disposable edit grant, authenticated revoke, refresh 403 `grant_revoked`, UI Unavailable/read-only. | Continue Phase 3.3. |
| 2026-05-21 | 1 | Phase 3.3 revoked view link passed. | Disposable view grant, authenticated revoke, reload unavailable/forbidden, no editor/provider websocket. | Continue Phase 3.4. |
| 2026-05-21 | 1 | Phase 3.4 role downgrade passed. | Disposable edit grant downgraded to view by scoped SQL; refresh 403 `forbidden`; UI Unavailable/read-only; no conflict state. | Continue Phase 3.5. |
| 2026-05-21 | 1 | Phase 3.5 guest quota skipped for current dev/manual pilot workspace. | Authenticated alpha smoke confirmed `concurrentGuestEdits: 1000`. | Continue Phase 3.6. |
| 2026-05-21 | 1 | Phase 3.6 native bearer spoof check passed. | Disposable edit link with `clientKind=app` still created browser session and mounted browser shell. | Continue Phase 4.1. |
| 2026-05-21 | 1 | Phase 4.1 guest editing while host app is offline passed. | User manual visual/file check. | Continue Phase 4.2. |
| 2026-05-21 | 1 | Phase 4.2 browser offline/reconnect passed. | Two-context Playwright check: offline IndexedDB persistence, reconnect flush, observer received edits once. | Continue Phase 4.3. |
| 2026-05-21 | 1 | Phase 4.3 missing local file projection pause passed with P2-003. | User manual visual/file check; app showed explicit projection-ingest failure, but error styling was too neutral. | Continue Phase 4.4. |
| 2026-05-21 | 1 | Phase 4.4 disk/provider divergence conflict UI passed with P2-004. | User manual visual/functional check; conflict UI works but is cramped in collaboration sidebar. | Continue Phase 4.5. |
| 2026-05-21 | 1 | Phase 4.5 paste-resolved confirmation guard passed. | User manual functional check. | Continue Phase 4.6. |
| 2026-05-21 | 1 | Phase 4.6 external atomic save during conflict passed. | User manual visual/file check; external atomic replacement remained visible after resolution, which proves it was not silently overwritten. | Continue added Phase 4.7/4.8. |
| 2026-05-21 | 1 | Phase 4.8 active user typing vs agent blind atomic replace passed. | User manual screenshot showed explicit conflict with local disk agent replacement, shared editor user typing, and non-empty diff. | Resolve conflict; then run Phase 4.7 or continue Phase 5. |
| 2026-05-21 | 1 | Gate 1 manual pilot acceptance passed. | Phase 5 visual check passed; bug summary appended; all findings classified with no open P0/P1. | Start Gate 2.5 dead code inventory and safe removal. |

## Current Open Decisions

| Decision | Options | Owner | Needed by | Status |
| --- | --- | --- | --- | --- |
| RC SHA | Original `c1333b4e7a3a0d47ec6db2269bd97638b27de124`; patched code commit `cf3a2691a3601e946d01f3cfb3b67789ce08f31b` | TBD | Gate 0 | Decided for patched RC |
| Pilot auth path | OIDC vs invite-token bootstrap vs magic link | TBD | Gate 6 | Open |
| Data retention | 30-day alpha retention vs shorter TTL | TBD | Gate 3 | Open |
| Provider backup | Fly snapshots only for alpha vs explicit off-volume backup | TBD | Gate 3 | Open |
| Free alpha caps | Workspace/doc/storage/session limits | TBD | Gate 4 | Open |
| Dead code scope | Delete now vs archive only vs keep temporarily | TBD | Gate 2.5 | Open |
| Active simplification timing | Before pilot only for blockers vs after pilot evidence | TBD | Gate 9.5 | Deferred |
| Pilot size | 3-10 users vs 10-50 users | TBD | Gate 9 | Open |
| Paid launch timing | After small pilot vs after broader beta | TBD | Gate 11 | Deferred |

## Next Action

Start Gate 2.5 dead code inventory and safe removal on patched RC code commit `cf3a2691a3601e946d01f3cfb3b67789ce08f31b`.

Next acceptance row: inventory old approach candidates, classify each as `Delete now`, `Archive only`, `Keep temporarily`, or `Simplify later`, and make no active-code simplification unless it is needed to remove confirmed dead paths.
