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

## Status Values

- `Not started` - no current evidence.
- `In progress` - actively being worked.
- `Blocked` - cannot complete until a named issue is fixed.
- `Passed` - evidence recorded in this document or linked docs.
- `Deferred` - explicitly not required for the small pilot.

## Launch Rule

Do not invite external pilot users until Gates 0-8, including Gate 2.5, are either `Passed` or explicitly marked `Deferred` with a reason and owner.

Do not enable paid billing until Gates 10.5 and 11 are `Passed`.

Do not publish website/video broadly until Gates 0-10 are `Passed` or the website/video clearly labels the product as private pilot. Gate 9.5 is allowed to remain deferred for private pilot, but must be completed before broader beta or public launch.

Do not launch paid or broader public distribution until Gate 10.5 proves the app can be installed and updated through an accepted signed/notarized or explicitly bounded beta channel.

## Gate Summary

| Gate | Area | Status | Owner | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Release candidate freeze | Passed | TBD | Patched RC code commit `cf3a2691a3601e946d01f3cfb3b67789ce08f31b` passed the Gate 0 baseline. |
| 1 | Manual pilot acceptance | Passed | TBD | Phases 1-5 passed on patched RC; no open P0/P1 after P1-001 fix; P2-003 and P2-004 fixed; P2-002 remains an accepted visual latency follow-up. |
| 2 | P0/P1 blocker fix pass | Passed | TBD | P1-001 fixed, verified, and re-frozen into the patched RC. Cleanup-review P1 native app-marker regression fixed in Gate 2.5 follow-up. |
| 2.5 | Dead code inventory and safe removal | Passed | TBD | Removed the old remote-main daemon/CLI/web/relay compatibility stack from active code; fixed non-judgment cleanup-review P1/P2 follow-ups; baseline stayed green. |
| 3 | Server/data lifecycle audit | Passed | TBD | Commit `3e669dec2479ec710ef6bef4a6a03e536bc32558` deployed to Fly release `v13`. Health, authenticated alpha smoke, hosted provider version/restore, Delete Cloud Copy, old link/session/provider-token denial, and autosave retention tests passed. Follow-up lifecycle cleanup added tombstone-driven provider physical cleanup and scheduled stale metadata/cache cleanup. Full Neon/Fly infrastructure restore drill remains in the final launch gate. |
| 4 | Cost instrumentation and unit economics | Passed | TBD | Passed for the small free pilot scope. Usage reporter was added and run against deployed Fly alpha; public Fly/Neon/Stripe rate-card scenarios and temporary pilot cost guardrails are documented in [`gate4-cost-instrumentation-unit-economics.md`](./gate4-cost-instrumentation-unit-economics.md). Actual Fly/Neon billing snapshots, final Free plan packaging, and paid no-loss pricing are deferred to Gate 11. |
| 5 | Clean install and distribution | Passed | TBD | Passed for the controlled technical pilot scope using the documented per-app Gatekeeper workaround. Repo-outside zip install, package verification, unpacked app launch, hosted edit/view link creation, app-to-app join, and quit/reopen binding restoration passed from commit `a378a26ae6d5712e84c16650d63ff0ebb2ebd8e1`; the current reviewed RC was rebuilt and package-verified after Gate 5/6 fixes. No-warning public/non-technical distribution remains blocked on Developer ID signing/notarization. |
| 6 | Login, onboarding, workspace UI | In progress | TBD | Repo-side OIDC owner onboarding, native callback handling, workspace list/create, account settings, app sign-in enforcement, guest browser links, and Google sign-in UI are implemented and deployed to Fly release `v15`. Gate 6 is still open until an interactive hosted Google login/native callback/workspace smoke passes. |
| 7 | Security, privacy, and ops gate | Not started | TBD | |
| 8 | Public docs cleanup and old approach archive | Not started | TBD | |
| 9 | Small external pilot | Not started | TBD | |
| 9.5 | Post-pilot active-code simplification | Deferred | TBD | Wait for real pilot findings. |
| 10 | Brand, website, and video | Not started | TBD | |
| 10.5 | Signed distribution and update pipeline | Deferred | TBD | Not required for the small controlled pilot. Required before broader beta/public or paid launch; covers Developer ID signing/notarization, release artifacts, manual update instructions, and later auto-update/appcast. |
| 11 | Paid billing and pricing launch | Deferred | TBD | Not required for small free pilot. Must wait for Gate 4 unit economics and Gate 10.5 distribution/update readiness. |

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

Goal: remove or quarantine old implementation paths only after the RC has been manually exercised and P0/P1 findings are understood. This gate now includes removing the old remote-main daemon/CLI/web/relay compatibility stack from active code so Gate 3 does not analyze the wrong product.

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

- [x] Create an inventory table of old approach candidates:
  - [x] local daemon code;
  - [x] old `/relay` or `/local` routes;
  - [x] old host-gated local sync tests;
  - [x] disabled Playwright specs;
  - [x] stale scripts;
  - [x] stale docs outside `docs/Archive`;
  - [x] unused package scripts;
  - [x] unused fixtures or generated artifacts.
- [x] For every candidate, record:
  - [x] path;
  - [x] classification;
  - [x] current references from `rg`;
  - [x] decision;
  - [x] owner;
  - [x] rollback note.
- [x] Verify active references before deletion:
  - [x] TypeScript imports;
  - [x] Swift package targets;
  - [x] Node package exports;
  - [x] `package.json` scripts;
  - [x] CI/test commands;
  - [x] app route registration;
  - [x] CLI entrypoints;
  - [x] README/current docs.
- [x] Delete only `Delete now` candidates.
- [x] Move or mark `Archive only` candidates so they are not discovered by test/build tooling.
- [x] Leave `Keep temporarily` candidates in place with a short TODO or tracking note if their status is confusing.
- [x] Do not change the active pilot path:
  - [x] native app open/share/join;
  - [x] `/collab`;
  - [x] `/api/*`;
  - [x] provider proxy under `/d/<providerDocId>/...`;
  - [x] Neon schema;
  - [x] Fly Y-Sweet persistence.
- [x] Re-run baseline checks after cleanup:
  - [x] `npx -y pnpm@10.0.0 typecheck`
  - [x] `npx -y pnpm@10.0.0 test`
  - [x] `swift test --package-path apps/marklab-macos`
  - [x] package verification if package scripts or native app files changed.

Progress log:

| Date | Candidate/Area | Decision | Evidence | Next |
| --- | --- | --- | --- | --- |
| 2026-05-21 | Gate created. No inventory yet. | Not started | This document. | Run inventory after Gate 2. |
| 2026-05-21 | `infra/docker/web.Dockerfile` | Delete now | `rg` found no active build, package script, CI, or production deploy reference. `apps/api/src/config/production-deploy-config.test.ts` explicitly asserts production compose does not reference `infra/docker/web.Dockerfile`, and production API image builds `apps/collab-web`, not `apps/web`. | Deleted; rollback by restoring from git if a future archived-web compatibility build is deliberately revived. |
| 2026-05-21 | `apps/web/tests/archived/local-file-sync.spec.ts.disabled` | Delete now | File has `.disabled` suffix and is outside Playwright discovery. The later expanded Gate 2.5 cleanup removed the entire old `apps/web` surface and API local/relay compatibility tests from active code. | Deleted; rollback by restoring from git only for historical forensic comparison outside the pilot. |
| 2026-05-21 | `apps/web/**` legacy browser app surface | Delete now | This was the old remote-main browser surface, not the current `/collab` app. Root `typecheck` now excludes it; production build and serving use `apps/collab-web`. | Deleted; rollback by restoring from git only if the old surface is deliberately revived outside the pilot. |
| 2026-05-21 | `apps/api/src/local/**`, `apps/api/src/routes/local-*` | Delete now | The active native app projects shared provider state to local disk directly. `/api/local/*` and local file service tests belonged to the old daemon boundary. | Deleted; rollback by restoring from git only if a new local-file API design is approved. |
| 2026-05-21 | `apps/api/src/relay/**`, `apps/api/src/routes/relay-routes.ts` | Delete now | The current pilot uses access grants plus Y-Sweet provider tokens, not `/relay/<room>` host-gated rooms. API upgrade handling now routes only provider proxy and `/collab`. | Deleted; health/schema tests no longer require relay tables or relay readiness. |
| 2026-05-21 | `apps/cli/marklab.mjs` legacy daemon commands plus `daemon-supervisor.mjs`, `relay-config.mjs`, `recent-files.mjs`, and `wait-for-sync.mjs` | Delete now | CLI now exposes current app/deep-link/status/conflict commands only. Old `start`, `serve`, daemon-only share, relay link, recent, version, and legacy opt-in paths were removed. | Deleted legacy helper modules and compatibility tests; current CLI tests cover removed-command rejection and active commands. |
| 2026-05-21 | Native optional local-daemon boundary and daemon Swift helpers | Delete now | `MarkLab.app` no longer exposes or conditionally connects a daemon boundary. The old daemon collaborator label and inspector section were removed. | Deleted `NativeDaemonClient`, `NativeDaemonRegistry`, `NativeShareController`, and related tests. |
| 2026-05-21 | Legacy schema tables `relay_rooms`, `relay_access_grants`, `relay_access_sessions` | Delete now | Current sessions use `collab_sessions`, `provider_token_issuances`, `document_access_grants`, and `document_access_sessions`. Health checks no longer require relay tables. | Removed relay table creation from schema. Existing deployed tables, if any, are inert until a later explicit drop migration. |
| 2026-05-21 | Current docs outside `docs/Archive` mentioning daemon or `apps/web` | Archive/update now | Public docs must not tell pilot operators or users to use the old daemon route. Historical planning docs can remain under `docs/Archive` or `docs/plans`. | README and Fly operator docs updated in this cleanup; broader Gate 8 still audits product/agent/production docs before public launch. |
| 2026-05-21 | Gate 2.5 verification | Passed | `npx -y pnpm@10.0.0 typecheck` passed; `npx -y pnpm@10.0.0 test` passed with 61 files and 470 tests plus 1 skipped; `swift test --package-path apps/marklab-macos` passed with 68 tests; `package:app` and `verify:package` passed for `/Users/fuyuming/Desktop/markdown_ai_collab_milkdown_spec/dist/MarkLab.app`. | Gate 2.5 passed; continue Gate 3 server/data lifecycle audit. |

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

- [x] Create a storage map: local file, app support files, Neon tables, Fly volume paths, logs, generated artifacts.
- [x] Define document lifecycle:
  - [x] local-only file;
  - [x] Start Sharing;
  - [x] active shared document;
  - [x] Stop Sharing;
  - [x] document deletion;
  - [x] workspace/account deletion.
- [x] Define retention policy:
  - [x] access grants;
  - [x] access sessions;
  - [x] collab sessions;
  - [x] provider token issuances;
  - [x] versions/snapshots;
  - [x] provider documents;
  - [x] logs.
- [x] Define deletion semantics:
  - [x] revoke link;
  - [x] Stop Sharing;
  - [x] Delete Cloud Copy;
  - [x] Clear Local MarkLab Data;
  - [x] delete cloud document;
  - [x] delete workspace;
  - [x] delete account;
  - [x] local file missing/deleted.
- [x] Define backup/restore:
  - [x] Neon backup/restore;
  - [x] Fly volume snapshot/fork restore;
  - [x] provider-state restore test result;
  - [x] alpha restore posture for manual pilot: hosted version restore verified; full Neon/Fly infrastructure restore drill moved to the final launch gate.
- [x] Define cleanup jobs needed before/after pilot:
  - [x] expired grants;
  - [x] expired sessions;
  - [x] stale provider token rows;
  - [x] inactive provider docs;
  - [x] old version snapshots;
  - [x] stale OIDC states;
  - [x] completed native CLI handoff responses;
  - [x] stale browser persisted edit sessions and matching IndexedDB caches.
- [x] Update public privacy/storage wording if policy differs from existing docs; corrected Stop Sharing wording to match server-backed active grant refresh and grant-id revocation after relaunch.
- [x] Decide product action model: `Stop Sharing` keeps hosted copy/version history; `Delete Cloud Copy` is the destructive hosted-content action; `Clear Local MarkLab Data` is the device/browser privacy reset action.
- [x] Confirm Version History current state: backend data/API and native shared-document UI now expose list/show/manual checkpoint/restore; browser collaborators are captured by server-side autosave but do not have version controls.
- [x] Align with current native UI pattern: the toolbar uses a menu first, then `Show Sharing & Versions` toggles the inspector.
- [x] Write implementation plan: [Sharing & Versions, Cloud Copy, And Version History Plan](../plans/2026-05-22-sharing-versions-cloud-copy-plan.md).
- [x] Rename toolbar menu/item to `Sharing & Versions` / `Show Sharing & Versions`.
- [x] Add Stop Sharing hover/help microcopy.
- [x] Redesign the Sharing & Versions inspector with inline Sharing and Versions modes; move `Autosave Local Files` to app Settings.
- [x] Wire Version History UI to existing list/show/manual-save/autosave/restore APIs.
- [x] Retract pilot fallback for Delete Cloud Copy as sufficient Gate 3 behavior.
- [x] Document pilot fallback for Clear Local MarkLab Data.
- [x] Implement self-serve `Delete Cloud Copy` in the product flow.
- [x] Implement autosave-version retention policy: protect manual/import/create/rollback checkpoints, prune only autosave snapshots outside the latest 30 days of the branch edit timeline.
- [x] Re-run hosted delete/version lifecycle smoke after deletion and retention land.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Current storage model recorded from existing launch docs. | `fly.toml`, `alpha-launch-runbook.md`, `privacy-and-storage.md` | Write lifecycle policy draft. |
| 2026-05-22 | Gate 3 started after Gate 2.5 conflict-review follow-up was committed and pushed. | `51e55c4 fix: streamline native conflict review UI`; worktree clean on `macos-app`. | Build implementation-grounded storage/lifecycle map from current schema, app-support stores, Fly config, and production docs. |
| 2026-05-22 | Gate 3 lifecycle audit draft created and public storage wording corrected. At this point, the draft still treated hosted content as retained until manual cleanup and listed cloud document/workspace/account deletion, cleanup jobs, and restore drill evidence as missing. Later Gate 3 work added Delete Cloud Copy and autosave retention; full infrastructure restore drill moved to the final launch gate. | `docs/manual-acceptance/server-data-lifecycle-audit.md`; `docs/production/privacy-and-storage.md`; evidence checked in `schema.sql`, native app-support stores, browser localStorage/IndexedDB code, `fly.toml`, and production runbooks. | Superseded by later Gate 3 lifecycle rows. |
| 2026-05-22 | Gate 3 product lifecycle model accepted. `Stop Sharing` remains a non-destructive sharing/sync stop with hover/help copy; `Delete Cloud Copy` belongs in the `Cloud Copy & Versions` Danger Zone; `Clear Local MarkLab Data` belongs in app Settings Privacy/Support/Reset. | `docs/manual-acceptance/server-data-lifecycle-audit.md`; `docs/production/privacy-and-storage.md` | Implement Stop Sharing microcopy first, then add Delete Cloud Copy and Clear Local MarkLab Data fallbacks/implementation with regression tests. |
| 2026-05-22 | Version History was pulled into Gate 3 scope. Backend support exists through `document_versions` and version list/show/save/restore routes, but the native hosted UI has no complete Versions panel. | `apps/api/src/routes/version-routes.ts`; `apps/api/src/services/version-service.ts`; `apps/api/src/db/schema.sql`; `docs/product/marklab-alpha-user-guide.md` | Build the `Cloud Copy & Versions` surface with `Versions` and `Danger Zone`; make Version History visible before user-facing Delete Cloud Copy. |
| 2026-05-22 | Gate 3 UI placement aligned to the existing native pattern. The toolbar remains a two-step menu-plus-inspector flow: `Sharing & Versions` opens quick sharing actions, and `Show Sharing & Versions` toggles the inline inspector with Sharing and Versions modes. | `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; `docs/manual-acceptance/server-data-lifecycle-audit.md` | Implement labels and Stop Sharing help first, then build the inline Sharing/Versions inspector. |
| 2026-05-22 | Focused Gate 3 implementation plan written for Sharing & Versions, Cloud Copy, Version History, Delete Cloud Copy, Clear Local MarkLab Data, cleanup jobs, and restore drill. | `docs/plans/2026-05-22-sharing-versions-cloud-copy-plan.md` | Start Phase 1: labels and Stop Sharing help copy only. |
| 2026-05-22 | Phase 1 of Sharing & Versions plan completed. Native toolbar menu, inspector toggle, and inspector title now use `Sharing & Versions`; Stop Sharing buttons expose hover/help copy explaining that cloud copy and version history are kept. | `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; `apps/marklab-macos/Tests/MarkLabMacOSTests/MarkLabNativeUIStrategyTests.swift`; verification: `swift test --package-path apps/marklab-macos` | Start Phase 2: add a Cloud Copy section and `Cloud Copy & Versions` sheet skeleton. |
| 2026-05-22 | Phase 2 skeleton completed. The Sharing & Versions inspector now has a Cloud Copy section explaining retained cloud/version data after Stop Sharing, and a `Cloud Copy & Versions` sheet skeleton with Versions and Danger Zone placeholders. No version API or destructive delete action is wired yet. | `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; `apps/marklab-macos/Tests/MarkLabMacOSTests/MarkLabNativeUIStrategyTests.swift` | Run Swift verification, then visual-check the new inspector section and sheet before Phase 3. |
| 2026-05-22 | Phase 2 visual review changed direction. The inspector must open even for local-only files, version history should live inline in the side panel so the current article remains visible, and Local Autosave should move out of the toolbar into settings. | User visual review; `docs/plans/2026-05-22-sharing-versions-cloud-copy-plan.md` | Replace the sheet skeleton with an inline Sharing/Versions inspector and move Local Autosave to settings before Phase 3. |
| 2026-05-22 | Phase 2 correction implemented. Sharing & Versions now opens for local-only files, the standalone Document/Local Autosave toolbar menu was removed, and Versions/Danger Zone placeholders live inline in the side inspector instead of a separate sheet. | `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; `apps/marklab-macos/Tests/MarkLabMacOSTests/MarkLabNativeUIStrategyTests.swift`; verification: `swift test --package-path apps/marklab-macos` | Package and visual-check the redesigned inspector before Phase 3. |
| 2026-05-22 | Phase 2 IA follow-up implemented with TDD. The side inspector now has only `Sharing` and `Versions`; `Local Autosave` moved to macOS app Settings and open document models refresh when the app setting changes. | `apps/marklab-macos/Sources/MarkLabApp/MarkLabSettingsView.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`; red/green test: `swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests/appSettingsDefaultsChangesRefreshLocalAutosaveInOpenModels`; full verification: `swift test --package-path apps/marklab-macos`, `package:app`, `verify:package`. | Continue Phase 3 native version client. |
| 2026-05-22 | Relay reference checked before Phase 4/5. Useful patterns are a dedicated Danger Zone, explicit local-file-preserved wording, list-plus-detail version UI, and returning to local state after remote delete. Relay's ambiguous metadata/history language and one-click destructive actions should not be copied. | `Learning resources/Relay/src/components/ManageSharedFolder.svelte`; `Learning resources/Relay/src/components/ManageRemoteFolder.svelte`; `Learning resources/Relay/src/components/ManageRelay.svelte`; `Learning resources/Relay/src/RelayManager.ts`; `Learning resources/Relay/src/SharedFolder.ts` | Use Relay only as UI/lifecycle reference; keep MarkLab's sharper `Stop Sharing` / `Delete Cloud Copy` / `Clear Local MarkLab Data` terms. |
| 2026-05-22 | Phases 3-4 code completed with TDD. Native now calls existing version list/show/manual-save/autosave/restore routes, maps forbidden/unavailable/stale errors, and the `Versions` inspector shows a manual checkpoint action, a version list, selected metadata/source preview, and a `RESTORE` confirmation before restore. | `apps/marklab-macos/Sources/MarkLabMacOS/NativeControlPlaneShareClient.swift`; `apps/marklab-macos/Sources/MarkLabMacOS/NativeHostedShareController.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; red/green tests in `NativeControlPlaneShareTests`, `MarkLabAppModelTests`, and `MarkLabNativeUIStrategyTests`; verification: `swift test --package-path apps/marklab-macos` passed 79 tests. | Package app and run the required Phase 4 visual checkpoint for sidebar readability and restore confirmation before starting Delete Cloud Copy backend. |
| 2026-05-22 | Phase 4 visual feedback exposed a real backend gap. The UI naming was acceptable, but Save Checkpoint/Autosave/Restore were still reading or writing the stale Postgres mirror instead of the active Y-Sweet provider. Version routes now prefer the live provider snapshot for manual/autosave checkpoints and restore writes the rollback Markdown back into the provider before the native editor reloads. | User visual report; Google official version-history behavior reference; red/green tests: `version-routes.test.ts` live provider snapshot/manual-save and restore-provider apply cases; `ysweet-token-service.test.ts` provider apply case; supporting native tests: `NativeControlPlaneShareTests/usesExistingVersionHistoryRoutes`, `MarkLabAppModelTests/loadsPreviewsSavesAndRestoresSharedVersionHistory`, `MarkLabNativeUIStrategyTests/versionRowsUseFilenameTimestampAndCheckpointLabels`. | Run full verification/package, then rebuild/open against an API containing this backend fix for one Phase 4 visual re-check focused on Save Checkpoint and Restore. |
| 2026-05-22 | Phase 4 local visual re-check passed, then version creation semantics were tightened. Browser/app writes now share one versioning model: both write active provider state, server-side provider autosave creates automatic snapshots from that state, and native `Cmd+S` creates a manual checkpoint like `Save Checkpoint`. Browser still has no version UI or restore control. | User local visual pass on Save Checkpoint/Restore; red/green tests: `provider-autosave-service.test.ts` for provider-backed autosave from active state; `MarkLabAppModelTests/commandSaveCreatesManualCheckpointForSharedDocuments` for shared-mode `Cmd+S`. | Run full verification/package, then decide whether Phase 4 needs one more visual check for `Cmd+S` status text or can proceed to Delete Cloud Copy backend. |
| 2026-05-22 | App Settings autosave copy clarified. The setting is now labeled `Autosave Local Files` and states that it only applies when a file is not sharing; shared documents sync automatically and create online version checkpoints. | `apps/marklab-macos/Sources/MarkLabApp/MarkLabSettingsView.swift`; red/green test: `swift test --package-path apps/marklab-macos --filter MarkLabNativeUIStrategyTests/localAutosaveBelongsToAppSettings`. | Continue Gate 3 after package verification. |
| 2026-05-22 | Gate 3 deploy candidate committed and deployed. Local verification passed, then Fly alpha release `v12` deployed image `deployment-01KS79449HXYWDQ4HNQQ88K2NQ`. External health and read/write provider-version smoke passed. | Commit `7f47410cf8ba4c19a73c7bf725995722675b5560`; `npx -y pnpm@10.0.0 typecheck`; root Vitest suite; `swift test --package-path apps/marklab-macos`; `package:app`; `verify:package`; `smoke:native-browser`; `fly deploy -a marklab-relay-alpha --local-only --depot=false --wait-timeout 10m --yes`; `/healthz` returned `ok: true`, database/schema/provider/store ready; alpha smoke returned `ok: true`; hosted provider-version smoke created disposable doc `1a600b8a-7e77-4af7-b579-d0f422c909e7`, wrote via Y-Sweet websocket, manual-saved version 2, restored version 3, and confirmed export returned restored provider state. | Deploy/version path passed, but Gate 3 remains open. Implement self-serve Delete Cloud Copy and define version retention before marking Gate 3 passed. |
| 2026-05-22 | Gate 3 status corrected after lifecycle review. `Delete Cloud Copy` must be implemented before Gate 3 passes, not left as an operator-only fallback. Current shared autosave wakes every 60 seconds, waits for a branch quiet window, and now follows a bounded page-history policy: active editing records autosave versions every 10 minutes, with a final checkpoint after the same provider hash is stable for 2 minutes. External references support bounded lifecycle behavior: Google may merge/prune old revisions, Notion records page versions every 10 minutes while editing and another 2 minutes after the last edit, and Lark exposes manual saved document versions and deleted-version restore windows. | `apps/api/src/services/provider-autosave-service.ts`; `apps/api/src/services/save-policy.ts`; `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`; sources recorded in `docs/manual-acceptance/server-data-lifecycle-audit.md`. | Implement `Delete Cloud Copy`; implement autosave-only version retention: protect manual/import/create/rollback checkpoints and prune autosave rows outside the latest 30 days of each branch's own edit timeline. |
| 2026-05-22 | Delete Cloud Copy and autosave retention landed locally with TDD. Delete Cloud Copy is manage-access-only, revokes grants, closes sessions, tombstones provider docs, denies old links/session refresh/provider access, and clears native hosted state while preserving the local Markdown file. Autosave now records the first dirty observation without an immediate version, checkpoints active editing every 10 minutes, writes a final checkpoint after 2 minutes of stable provider state, and prunes only autosave rows outside the latest 30 days of that branch's edit timeline. Full Neon PITR and Fly volume restore drill were moved out of Gate 3 to the final launch gate. | `apps/api/src/services/save-policy.ts`; `apps/api/src/services/version-service.ts`; `apps/api/src/services/cloud-copy-service.ts`; `apps/api/src/routes/cloud-copy-routes.ts`; `apps/api/src/provider/ysweet-provider-websocket-proxy.ts`; `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; targeted tests: `npx -y pnpm@10.0.0 test apps/api/src/services/save-policy.test.ts apps/api/src/services/version-service.test.ts apps/api/src/services/provider-autosave-service.test.ts apps/api/src/services/cloud-copy-service.test.ts apps/api/src/routes/cloud-copy-routes.test.ts apps/api/src/provider/ysweet-provider-websocket-proxy.test.ts`; `swift test --package-path apps/marklab-macos --filter NativeControlPlaneShareTests/deletesCloudCopyThroughHostedDocumentRoute --filter MarkLabNativeUIStrategyTests/sharingAndVersionsLabelsExplainRetainedCloudCopy --filter MarkLabAppModelTests/deleteCloudCopyClearsHostedStateAndKeepsLocalMarkdown`. | Run full verification and hosted delete/version lifecycle smoke before marking Gate 3 passed. |
| 2026-05-22 | Full local verification passed after Delete Cloud Copy and autosave retention. TypeScript typecheck passed, full Vitest passed, full Swift test passed, packaged app build/verification passed, and native-browser smoke still passed. Hosted delete/version lifecycle smoke is still pending because this code has not been deployed in this turn. | `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 test` reported 64 files passed, 492 tests passed, 1 skipped; `swift test --package-path apps/marklab-macos` reported 83 tests passed; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser`. | Deploy, run hosted delete/version lifecycle smoke, then decide whether Gate 3 can be marked passed or needs one manual visual check of the Danger Zone. |
| 2026-05-22 | Gate 3 deployed and passed for the small manual pilot lifecycle scope. Schema was applied to the existing Fly machine from commit `3e669dec2479ec710ef6bef4a6a03e536bc32558`, Fly alpha release `v13` deployed image `deployment-01KS7MG85ZKBRRHHFA3EWQKMQZ`, health stayed green, authenticated alpha smoke passed, and hosted delete/version lifecycle smoke passed. The hosted smoke created disposable doc `dfa636d1-937f-4c56-b9c1-701962349328`, wrote through a real Y-Sweet provider session, manual-saved version 2, restored the initial version as rollback version 3, deleted the cloud copy, and confirmed old grant access `403`, old provider-token refresh `404`, provider proxy tombstone `410`, and versions route denial `403`. | Commit `3e669dec2479ec710ef6bef4a6a03e536bc32558`; Fly release `v13`; `/healthz` returned `ok: true`, database/schema/provider/store ready; `MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 node scripts/marklab-alpha-smoke.mjs` returned `ok: true`; hosted lifecycle smoke marker `gate3-provider-version-delete-1779447368930-38312a64` returned `ok: true`; targeted post-hardening tests passed 6 files and 58 tests. | Gate 3 passed. Continue Gate 4 cost instrumentation and unit economics. Keep full Neon/Fly infrastructure restore drill in the final launch gate before more than 10 users or paid/public launch promises. |
| 2026-05-22 | Gate 3 lifecycle cleanup follow-up implemented. Physical provider cleanup now consumes `provider_doc_deletions` tombstones and removes only known direct-child Y-Sweet provider directories from the configured local process store. The API also has a scheduled lifecycle job for stale OIDC states, expired/revoked sessions and grants, old provider-token audit rows, old collab sessions, and tombstoned provider docs. Browser startup prunes stale persisted edit sessions and matching IndexedDB caches; native pending-request scans prune completed CLI responses older than 1 day. Workspace/account hard delete remains deferred to a later gate. | `apps/api/src/services/lifecycle-cleanup-service.ts`; `apps/api/src/db/schema.sql`; `apps/collab-web/src/api/edit-session-storage.ts`; `apps/marklab-macos/Sources/MarkLabMacOS/NativeCLIShareBridge.swift`; verification: lifecycle/schema/web storage targeted Vitest, cloud-copy/http/web-app regression Vitest, full `npx -y pnpm@10.0.0 typecheck`, and `swift test --package-path apps/marklab-macos --filter NativeCLIShareBridgeTests`. | Run final full verification, commit, push, then continue Gate 4. |
| 2026-05-22 | Gate 3 round-1 code review fixes landed locally. Restore protects live provider edits by checkpointing the pre-restore provider snapshot before rollback, then writing the rollback to provider/current state. Delete Cloud Copy closes active provider WebSockets in addition to tombstoning future access. Native restore/save/delete now abort when pending projection opens a conflict, ignores out-of-order version previews, and Stop Sharing keeps a retained cloud-copy reference so Versions/Delete Cloud Copy remain available after active sync is disabled. Docs were corrected away from stale collaboration labels and operator-only deletion language. | Fresh review agents found backend/provider lifecycle bugs, native restore/projection races, retained-cloud-copy UX mismatch, and stale docs. Targeted green tests: `npx -y pnpm@10.0.0 test apps/api/src/routes/version-routes.test.ts apps/api/src/routes/cloud-copy-routes.test.ts apps/api/src/provider/ysweet-provider-websocket-proxy.test.ts apps/api/src/services/provider-autosave-service.test.ts apps/api/src/services/lifecycle-cleanup-service.test.ts apps/collab-web/src/api/edit-session-storage.test.ts`; `swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests`. | Run broader verification, then round-2 fresh-agent review before committing. |
| 2026-05-22 | Gate 3 round-2 code review fixes landed locally. Revoking access grants, share links, and write-capable agent tokens now revokes active provider token issuances and closes provider WebSockets. Restore checkpoints the live provider snapshot before provider rollback and compensates the provider if DB restore fails after provider apply. Native restore now projects the server-returned rollback snapshot only after hash validation, version-history list responses are guarded against file switches, terminal browser sessions delete their matching IndexedDB cache, and Delete Cloud Copy retries are idempotent for admin/same-user tombstone retries. | Fresh round-2 agents reviewed the round-1 fixes plus the Gate 3 large commit. Targeted green tests: `npx -y pnpm@10.0.0 test apps/api/src/routes/cloud-copy-routes.test.ts apps/api/src/routes/access-routes.test.ts apps/api/src/routes/version-routes.test.ts apps/collab-web/src/api/edit-session-storage.test.ts`; `npx -y pnpm@10.0.0 typecheck`; `swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests`. | Run full TypeScript/Swift verification and `git diff --check`, then commit and push if clean. |

Exit criteria:

- A lifecycle/retention/deletion policy exists and matches implementation or clearly names gaps.
- Full Neon/Fly restore drill is tracked for the final launch gate, not Gate 3.
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

- [x] Add or run a usage-report script that can summarize by workspace:
  - [x] active documents;
  - [x] provider document count;
  - [x] estimated provider store bytes;
  - [x] Markdown bytes;
  - [x] version snapshot bytes;
  - [x] collab session minutes;
  - [x] guest edit session count;
  - [x] provider token refresh count;
  - [x] API request count if available; current result: unavailable because no request meter exists in the schema;
  - [x] estimated egress if available; current result: unavailable because no per-workspace egress meter exists in the schema/Fly CLI snapshot;
  - [x] last active time.
- [x] Record current Fly bill/cost explorer snapshot, or explicitly defer it to Gate 11 if closing Gate 4 for the small free pilot using public-rate assumptions.
- [x] Record current Neon usage snapshot, or explicitly defer it to Gate 11 if closing Gate 4 for the small free pilot using public-rate assumptions.
- [x] Estimate pilot cost per active workspace with public-rate scenarios; true p50/p90/p99 requires real pilot workspace distribution after Gate 9 starts.
- [x] Define temporary pilot cost guardrails, not the final Free plan:
  - [x] max workspaces;
  - [x] max active shared docs;
  - [x] max collaborators;
  - [x] max provider storage;
  - [x] max version retention;
  - [x] inactivity TTL.
- [x] Build pricing model:
  - [x] fixed infra cost;
  - [x] variable infra cost;
  - [x] support cost as an explicit input;
  - [x] payment fee;
  - [x] target gross margin; defer final margin target to Gate 11;
  - [x] no-loss floor formula and examples; final paid no-loss floor requires Gate 11 bill/support data.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. No usage meter/report is recorded here yet. | Existing cost discussion. | Inventory what usage data is already queryable from Neon/Fly. |
| 2026-05-22 | Gate 4 started. Added a read-only workspace usage reporter and ran it against the deployed Fly alpha by temporarily copying the script into the running machine so it could use the existing `DATABASE_URL` secret without printing it. The report covers active documents, provider doc count, provider store bytes, Markdown/Yjs/version bytes, collab minutes, guest edit sessions, provider token refreshes, last active time, whole-database size, and largest relation sizes. It explicitly reports API request count and egress as unavailable meters. | [`scripts/marklab-workspace-usage-report.mjs`](../../scripts/marklab-workspace-usage-report.mjs); `MARKLAB_PROVIDER_STORE_PATH=/data/ysweet node /app/scripts/marklab-workspace-usage-report.mjs --since-days 30`; [`gate4-cost-instrumentation-unit-economics.md`](./gate4-cost-instrumentation-unit-economics.md). Current snapshot: 1 active workspace, 15 active docs, 15 matched provider docs, 46,977 retained content bytes, 1,435.44 collab-session minutes, 52 guest edit sessions, 223 provider-token refreshes, 10,756,096-byte Neon database. | Capture actual Fly Cost Explorer/invoice and Neon CU-hour/history-storage usage; decide whether to add request/egress meters before pilot expansion. |
| 2026-05-22 | Public platform rate-card model added from current Fly, Neon, and Stripe pricing. The model separates small-free-pilot close from paid-pricing close: current public rates are enough to bound the small pilot, but paid pricing still needs actual bill/usage and support-time data in Gate 11. Current modeled whole-stack cost is about `$6.08-$29.95/month` across the listed pilot scenarios before support time; at 10 active workspaces this is about `$0.61-$3.00/workspace-month` before support. | [`gate4-cost-instrumentation-unit-economics.md`](./gate4-cost-instrumentation-unit-economics.md); official pricing references recorded for Fly.io, Neon, and Stripe. | Mark Gate 4 passed for the small free pilot scope; keep paid pricing blocked. |
| 2026-05-22 | Temporary pilot cost guardrails documented. These are not the final Free plan; specific free-plan packaging is deferred to the later billing/pricing gate. | [`gate4-cost-instrumentation-unit-economics.md`](./gate4-cost-instrumentation-unit-economics.md). | Continue Gate 5 clean install and distribution. |
| 2026-05-22 | Gate 4 accepted and passed for the small free pilot scope. Public-rate assumptions are accepted in place of immediate Fly/Neon dashboard billing snapshots for this gate. Actual bill snapshots, true p50/p90/p99 from real pilot workspaces, final Free plan packaging, target margin, and paid no-loss pricing are deferred to Gate 11. | Public-rate scenario summary below; [`gate4-cost-instrumentation-unit-economics.md`](./gate4-cost-instrumentation-unit-economics.md). | Start Gate 5. |

Public-rate scenario summary recorded for Gate 4:

| Scenario | Whole stack/month | 1 active workspace | 10 active workspaces | 50 active workspaces |
| --- | ---: | ---: | ---: | ---: |
| Neon free/near-zero, 0 GB Fly egress | `$6.08` | `$6.08` | `$0.61` | `$0.12` |
| Low pilot: 10 Neon CU-hours, 10 GB Fly egress | `$7.54` | `$7.54` | `$0.75` | `$0.15` |
| Base pilot: 50 Neon CU-hours, 10 GB Fly egress | `$11.78` | `$11.78` | `$1.18` | `$0.24` |
| Intermittent load: 140 Neon CU-hours, 50 GB Fly egress | `$22.92` | `$22.92` | `$2.29` | `$0.46` |
| Always-warm low load: 187.5 Neon CU-hours, 100 GB Fly egress | `$29.95` | `$29.95` | `$3.00` | `$0.60` |

Gate 4 conclusion: the small free pilot is cost-bounded while MarkLab remains on the current one-machine Fly architecture and the pilot stays within the documented guardrails. Storage is not the current cost driver; the real variables to watch are Neon compute, Fly egress, support time, and any need to scale beyond one always-on Fly machine.

Exit criteria:

- We can answer "what does one active workspace cost per month?" with a measured range.
- Temporary pilot cost guardrails are explicit; final Free plan packaging remains deferred to the billing/pricing gate.
- Paid pricing is not implemented until Gate 11 produces a real no-loss floor from actual bill/support data.

## Gate 5 - Clean Install And Distribution

Goal: prove a pilot user can install and use the app without the repo checkout. For the selected controlled technical pilot path, this means a supported user can use a repo-outside artifact with a documented per-app Gatekeeper workaround. It does not mean no-warning public distribution, and live first-run OIDC acceptance remains Gate 6.

Checklist:

- [x] Package MarkLab.app from the RC.
- [x] Install from a zipped artifact outside the repo checkout on the current macOS user. Separate-user/separate-Mac proof is deferred until broader/no-friction distribution.
- [x] Confirm app opens through LaunchServices from the unpacked artifact after the scoped per-app Gatekeeper workaround.
- [x] Confirm bundled editor resources load.
- [x] Confirm local file open works from the unpacked artifact.
- [x] Confirm hosted login/session configuration works through the historical controlled owner-token/CLI bridge. Current first-run owner login is Gate 6 OIDC and still needs live native callback smoke before Gate 6 can pass.
- [x] Confirm Start Sharing creates a workspace-owned document.
- [x] Confirm Create Edit Link and Create View Link work.
- [x] Confirm `marklab share file.md --edit` works through MarkLab.app.
- [x] Confirm app-to-app join works from an edit link.
- [x] Confirm quit/reopen restores shared bindings.
- [x] Record Gatekeeper/quarantine/signing/notarization behavior.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Existing automated package checks are not enough for this gate. | Plan 6 notes clean-install pass remains manual. | Run separate-user clean install after RC freeze. |
| 2026-05-22 | Gate 5 local packaged-app preflight started from commit `cf5f7ca36f9071d728ec629822a57a36fa6fd07f`. The app bundle packaged successfully at `dist/MarkLab.app`, package verification passed, and a LaunchServices probe started `MarkLabApp` from the `.app` bundle. | `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package`; `open -n dist/MarkLab.app` followed by `pgrep -fl MarkLabApp`. | Run the separate-user or separate-Mac clean install pass; then verify local open/edit/save and hosted sharing from outside the repo checkout. |
| 2026-05-22 | Signing/Gatekeeper behavior recorded. Current package is ad-hoc signed with bundle id `com.marklab.app`, has no TeamIdentifier, and is rejected by Gatekeeper assessment. This is acceptable for local preflight but not a non-developer distributable without signed/notarized packaging or explicit pilot workaround. | `codesign -dv --verbose=4 dist/MarkLab.app` reported `Signature=adhoc`; `spctl --assess --type execute --verbose=4 dist/MarkLab.app` returned `rejected`; `xattr -l dist/MarkLab.app` showed `com.apple.provenance` and no quarantine attribute in this local build. | Decide pilot distribution path: signed/notarized artifact, controlled workaround, or keep Gate 5 open until signing/notarization is implemented. |
| 2026-05-22 | Distribution path selected: controlled technical pilot workaround, not Apple Developer ID signing/notarization for this small gate. The package remains unsuitable for no-warning public/non-technical distribution. | [`gate5-controlled-pilot-install.md`](./gate5-controlled-pilot-install.md). | Build a repo-outside zip install artifact and run the controlled pilot install smoke. |
| 2026-05-22 | Gate 5 controlled pilot install smoke passed from commit `a378a26ae6d5712e84c16650d63ff0ebb2ebd8e1`. The app was packaged, zipped, unpacked outside the repo checkout, quarantine behavior was simulated, scoped quarantine removal was verified, and the unpacked app launched with a clean app-support directory. Hosted owner-token/CLI flow created edit and view links for hosted doc `30fb11c1-494d-4c63-9be8-ff29ac424d5f`; app-to-app join reached `synced` with provider export `verified` after quit/reopen. | `package:app`; `verify:package`; `ditto -c -k --sequesterRsrc --keepParent`; `node apps/marklab-macos/scripts/verify-packaged-app.mjs /tmp/marklab-gate5-install-a378a26ae6d5/MarkLab.app`; `spctl --assess --type execute --verbose=4`; `xattr -dr com.apple.quarantine`; `open -n -F --env MARKLAB_APP_SUPPORT_DIR=... /tmp/marklab-gate5-install-a378a26ae6d5/MarkLab.app --args ...`; `node apps/cli/marklab.mjs share ... --edit --json`; `node apps/cli/marklab.mjs share ... --view --json`; `node apps/cli/marklab.mjs join ... --json`; `node apps/cli/marklab.mjs status ... --json`. Access tokens were not recorded. | Gate 5 passed only for controlled technical pilot distribution. Continue Gate 6 login/onboarding/workspace UI before inviting non-technical pilot users. |
| 2026-05-22 | Gate 5 first-round code review hardening applied. Stale install docs now point to the `.app` packaging script and scoped quarantine workaround instead of zipping a raw Swift binary; the alpha runbook separates packaged OIDC pilot start from operator-token fallback; README now uses `Show Sharing & Versions` and the current Stop Sharing/Delete Cloud Copy semantics; package verification output distinguishes ad-hoc signing from Developer ID/notarized distribution. | Round 1 Gate 5 reviewer findings; `README.md`; `docs/manual-acceptance/pilot-acceptance-checklist.md`; `docs/production/alpha-launch-runbook.md`; `apps/marklab-macos/scripts/package-app.mjs`; `apps/marklab-macos/scripts/verify-packaged-app.mjs`; targeted package verification pending after this doc/code pass. | Run package/verify and second-round review before commit. |
| 2026-05-22 | Gate 5 second-round review P2 fixes applied and current RC package verification passed. The Gate 5 install evidence now clearly separates historical repo-outside install smoke from current-RC package verification, and `verify-packaged-app.mjs` reports `signingMode: "unknown"` if codesign details cannot be parsed instead of falsely classifying unknown signatures as certificate-signed. | Round 2 Gate 5 reviewer findings; [`gate5-controlled-pilot-install.md`](./gate5-controlled-pilot-install.md); `apps/marklab-macos/scripts/verify-packaged-app.mjs`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package` reported `signingMode: "ad-hoc"`, `signature: "adhoc"`, `teamIdentifier: "not set"`, `developerIdSigned: false`, `gatekeeperAccepted: false`, `notarized: false`, and `distributionReady: false`. | Commit and push the reviewed RC; Gate 5 remains passed for controlled technical pilot only. |

Exit criteria:

- Clean install pass is recorded.
- Any required installation workaround is documented before pilot.

## Gate 6 - Login, Onboarding, And Workspace UI

Goal: replace operator-token handoff with a real first-run path suitable for pilot users.

Checklist:

- [x] Pick login strategy for small pilot:
  - [x] OIDC;
  - [ ] invite-token bootstrap;
  - [ ] email magic link;
  - [ ] other.
- [x] Define first-run native app flow:
  - [x] unauthenticated state;
  - [x] sign-in;
  - [x] workspace select/create;
  - [x] session persistence;
  - [ ] token refresh/expiry;
  - [x] sign out.
- [x] Define browser flow:
  - [x] host/admin workspace settings;
  - [x] edit link without login;
  - [x] view link without login;
  - [x] expired/revoked link.
- [ ] Implement or verify UI states:
  - [x] missing workspace;
  - [x] auth failure;
  - [ ] quota exceeded;
  - [ ] provider unavailable;
  - [x] session expired.
- [x] Update user guide with real login path.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-21 | Gate created. Current broad-pilot caveat is that dev-login is disabled in production and operator token bootstrap is not a normal user path. | `README.md`, `alpha-launch-runbook.md` | Choose login strategy. |
| 2026-05-22 | Gate 6 direction fixed: owner login uses OIDC permanently; self-serve sign-up/login is acceptable for the small pilot because discovery is controlled operationally; browser guest edit/view links stay no-login; MarkLab.app usage requires owner login, and app collaborator presence names should use the logged-in OIDC display name. Deferred follow-ups stay in later gates: stronger token storage/session expiry handling in Gate 7, final free/paid packaging in Gate 11, and public onboarding copy cleanup in Gate 8. | Product decision captured in this log; implementation scope set to OIDC hosted `/signin` and native `marklab://auth/callback` handoff. | Implement the native/browser first-run path and workspace list/create support. |
| 2026-05-22 | Implemented the repo-side Gate 6 login/onboarding slice. Hosted web now serves `/signin` and `/auth/callback`; `/signin` starts OIDC and `/auth/callback` creates the API session then hands the native app an owner session through `marklab://auth/callback`. The API exposes `GET /api/workspaces` for logged-in users. MarkLab.app can receive the callback, verify `/api/auth/session`, list or create a workspace, persist the owner account locally, rebuild the hosted share controller without exported env vars, sign out from Settings, block shared-link opening while signed out, and pass the OIDC display name into app `/collab` URLs as `name=` for presence/cursor display. Browser edit/view links continue to work without login. | Code paths: `apps/api/src/routes/workspace-routes.ts`, `apps/api/src/services/workspace-service.ts`, `apps/collab-web/src/auth/AuthFlow.tsx`, `apps/collab-web/src/App.tsx`, `apps/marklab-macos/Sources/MarkLabMacOS/NativeAccountClient.swift`, `apps/marklab-macos/Sources/MarkLabApp/NativeAccountStore.swift`, `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`, `apps/marklab-macos/Sources/MarkLabApp/MarkLabSettingsView.swift`. Targeted verification passed: `npx -y pnpm@10.0.0 vitest run apps/api/src/routes/workspace-routes.test.ts`; `npx -y pnpm@10.0.0 vitest run apps/collab-web/src/App.test.tsx apps/api/src/http/app.test.ts`; `swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests`; `swift test --package-path apps/marklab-macos --filter MarkLabNativeUIStrategyTests/localAutosaveBelongsToAppSettings`. | Run full typecheck/test suite, configure hosted OIDC secrets when credentials exist, deploy schema/app, then smoke `/signin` through a real OIDC provider plus native callback/workspace creation before marking Gate 6 passed. |
| 2026-05-22 | Full local verification for the repo-side Gate 6 slice passed. The final native guard also moved the app join requirement below the UI layer so direct native joins require a signed-in owner session too; the app/CLI service can load the locally stored owner account for app-backed actions. | `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 test` returned 509 passed, 1 skipped; `swift test --package-path apps/marklab-macos` returned 94 tests passed. | Configure real hosted OIDC secrets, deploy the Gate 6 build, then run live OIDC/native callback/workspace smoke before marking Gate 6 passed. |
| 2026-05-22 | Added a deterministic local OIDC owner-onboarding smoke so Gate 6 can be regression-tested before real hosted provider credentials exist. The smoke starts a mock OIDC provider and API, exercises discovery, authorize, token exchange with PKCE, userinfo, API bearer session auth, empty workspace list, owner workspace create, post-create workspace list, and a redacted native `marklab://auth/callback` URL shape. It does not mark Gate 6 passed because hosted OIDC secrets/deploy/live native callback still need verification. | `apps/api/src/smoke/oidc-local-smoke.ts`; `apps/api/src/smoke/oidc-local-smoke.test.ts`; package script `smoke:oidc-local`; verification: `npx -y pnpm@10.0.0 exec vitest run apps/api/src/smoke/oidc-local-smoke.test.ts`; `npx -y pnpm@10.0.0 --filter @marklab/api exec tsx src/smoke/oidc-local-smoke.ts`. | Wire docs/checklists to the current OIDC path, then prepare Sign In UI review before real provider deploy. |
| 2026-05-22 | Prepared the Sign In / auth-callback UI for review instead of leaving the browser-default HTML surface. The page now has a compact MarkLab-styled panel, icon button, loading state, native-open callback link, signed-in confirmation, and readable auth error messages for unconfigured OIDC, failed exchange/userinfo, missing callback parameters, and malformed auth responses. This is ready for product review but not treated as final visual acceptance until reviewed. | `apps/collab-web/src/auth/AuthFlow.tsx`; `apps/collab-web/src/styles.css`; `apps/collab-web/src/App.test.tsx`; screenshots: `/tmp/marklab-gate6-ui/signin-native-polished-1280.png`, `/tmp/marklab-gate6-ui/signin-native-polished-mobile.png`; verification: `npx -y pnpm@10.0.0 exec vitest run apps/collab-web/src/App.test.tsx apps/api/src/smoke/oidc-local-smoke.test.ts`; `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 --filter @marklab/collab-web build`. | User review of the sign-in UI, then configure/deploy real hosted OIDC and run live native callback smoke. |
| 2026-05-22 | Sign In UI review direction updated to a Notion-minimal black-and-white style with a single Google entry point. The generic `Sign in` CTA was replaced by `Continue with Google`, and the copy now makes sign-in/sign-up explicit while preserving the same OIDC backend flow. | `apps/collab-web/src/auth/AuthFlow.tsx`; `apps/collab-web/src/styles.css`; `apps/collab-web/src/App.test.tsx`; screenshots: `/tmp/marklab-gate6-ui/signin-google-notion-1280.png`, `/tmp/marklab-gate6-ui/signin-google-notion-mobile.png`; verification: `npx -y pnpm@10.0.0 exec vitest run apps/collab-web/src/App.test.tsx`; `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 --filter @marklab/collab-web build`. | User review of the Google sign-in UI, then configure/deploy real hosted OIDC and run live native callback smoke. |
| 2026-05-22 | Final Google Sign In UI adjustment applied: removed the small top `MarkLab` label and replaced the placeholder `G` mark with a real multicolor Google logo inside a black outlined pill button, matching the requested minimal Google button direction. Hosted Fly inspection shows `MARKLAB_OIDC_*` secrets are not configured yet, so real hosted Google OAuth, deploy, and live callback smoke remain the Gate 6 blocker. | `apps/collab-web/src/auth/AuthFlow.tsx`; `apps/collab-web/src/styles.css`; `docs/production/alpha-launch-runbook.md`; screenshots: `/tmp/marklab-gate6-ui/signin-google-final-1280.png`, `/tmp/marklab-gate6-ui/signin-google-final-mobile.png`; verification: `npx -y pnpm@10.0.0 exec vitest run apps/collab-web/src/App.test.tsx`; `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 --filter @marklab/collab-web build`; `fly secrets list -a marklab-relay-alpha` showed no `MARKLAB_OIDC_*` entries. | Create Google OAuth Web application credential, set `MARKLAB_OIDC_*` Fly secrets, deploy current build, then run live native callback smoke before Gate 6 can pass. |
| 2026-05-22 | Hosted alpha now has Google OIDC secrets configured and the current Gate 6 build deployed. Deploy initially exposed a missing-schema health failure for `provider_doc_deletions.cleanup_*`; the checked-in schema was applied from inside the Fly machine using the existing `DATABASE_URL` secret, after which release `v15` became healthy. Hosted `/signin` now serves the current app shell, `/api/auth/oidc/start` returns a Google authorization URL with redirect URI `https://marklab-relay-alpha.fly.dev/auth/callback` and scopes `openid email profile`, and alpha smoke passed. The operator reports Google OAuth consent is now published to production, so Google should no longer require manually adding each pilot owner as a test user; this console state is not independently queryable from the repo. | Fly release `v15`; `fly secrets list -a marklab-relay-alpha` showed `MARKLAB_OIDC_(ISSUER|CLIENT_ID|CLIENT_SECRET|REDIRECT_URI)` deployed; `curl -fsS https://marklab-relay-alpha.fly.dev/healthz`; `curl -fsS https://marklab-relay-alpha.fly.dev/signin`; `POST /api/auth/oidc/start`; `MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev node scripts/marklab-alpha-smoke.mjs`; authenticated alpha smoke using `.env.marklab-pilot`; user-reported Google OAuth production publishing status. | Run an interactive Google login/native callback/workspace smoke before marking Gate 6 passed. |
| 2026-05-22 | Gate 6 first-round code review fixes applied. Manual-alpha bootstrap owners can migrate in place to verified Google/OIDC login by same email without losing user/workspace ownership; native `marklab://auth/callback` only accepts hosted origins matching the app's configured alpha/staging defaults; native OIDC intent is stored in server-side OIDC state instead of relying on browser `sessionStorage`; native Settings/App sign-out calls `/api/auth/logout`, clears local account state, and broadcasts matching-token account state changes to open windows; workspace settings now shows a Google sign-in path for expired sessions instead of raw `unauthorized`. | Round 1 Gate 6 reviewer findings; `apps/api/src/services/user-service.ts`; `apps/api/src/routes/auth-routes.ts`; `apps/api/src/db/schema.sql`; `apps/collab-web/src/auth/AuthFlow.tsx`; `apps/collab-web/src/workspaces/WorkspaceSettings.tsx`; `apps/marklab-macos/Sources/MarkLabApp/NativeAccountStore.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkLabSettingsView.swift`; verification: targeted API auth/schema/OIDC smoke Vitest, collab-web auth/settings Vitest, `swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests`. | Run full verification and second-round Gate 5/Gate 6 review. Live interactive Google/native callback smoke is still required before Gate 6 can pass. |
| 2026-05-22 | Gate 6 second-round code review fixes applied. Manual-alpha same-email migration now happens before subject upsert so Postgres unique violations do not abort the transaction; normal Open... document windows load `NativeAccountStore.defaultStore()` so they can share after Settings login; native callbacks must include the server-bound OIDC `nativeAppState` and match the app's locally pending `appState`; Settings and open document windows observe same-process sign-in/sign-out notifications; expired workspace sessions preserve return-to navigation through `/signin?returnTo=...`. Gate 6 is still open because the live interactive Google/native callback/workspace smoke has not been run after these fixes. | Round 2 Gate 6 reviewer findings; targeted verification: `npx -y pnpm@10.0.0 exec vitest run apps/api/src/routes/auth-routes.test.ts apps/api/src/smoke/oidc-local-smoke.test.ts apps/api/src/db/schema.test.ts apps/collab-web/src/App.test.tsx apps/collab-web/src/workspaces/WorkspaceSettings.test.tsx` returned 37 passed; `swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests` returned 35 passed. Full verification: `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 test` returned 518 passed, 1 skipped; `swift test --package-path apps/marklab-macos` returned 97 passed; `git diff --check`; `package:app`; `verify:package`. | Commit and push; then run live interactive Google/native callback/workspace smoke before marking Gate 6 passed. |
| 2026-05-27 | Gate 6 manual-test follow-up fixed two sharing UX issues before broader pilot testing. Hosted editor awareness now collapses duplicate same-name same-client-kind collaborator sessions using awareness freshness metadata, and a fresher no-cursor state suppresses an older stale cursor label. Native document toolbar now gives the Sharing & Versions control a low-interruption active state when a file is shared: `link.circle.fill`, blue tint, and a 12% blue capsule background. | User manual-test report; `packages/collab-editor/src/remote-cursors.ts`; `apps/collab-web/src/editor/CollaborativeMarkdownEditor.tsx`; `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; verification: focused remote cursor Vitest, focused SwiftUI strategy tests, `npx -y pnpm@10.0.0 typecheck`, `npx -y pnpm@10.0.0 test` returned 520 passed and 1 skipped, `swift test --package-path apps/marklab-macos` returned 98 passed, `package:app`, `verify:package`, `git diff --check`. | Deploy hosted alpha and reinstall the rebuilt app so the user can retest sharing-on UI and collaborator cleanup against live `/collab`. |
| 2026-05-27 | Gate 6 sharing UX follow-up deployed to hosted alpha and installed locally for retest. The first local-only Fly deploy attempt failed because Docker was unavailable; remote Depot deploy succeeded. Fly emitted the known transient listen/DNS warnings, but post-deploy health and DNS verification passed. | Runtime commit `126669f`; Fly release `v17`; image `registry.fly.io/marklab-relay-alpha:deployment-01KSMAW2MY0RJHB12BYES40HPJ`; `curl` `/healthz` passed on default, IPv4, and IPv6; `dig @1.1.1.1` returned A `66.241.124.14` and AAAA `2a09:8280:1::10f:9226:0`; read-only and authenticated `scripts/marklab-alpha-smoke.mjs` passed. | User retests sharing toolbar active state and collaborator pill cleanup in the installed app; Gate 6 still needs the full interactive native callback/workspace/share smoke before passing. |
| 2026-05-27 | Gate 6 manual retest follow-up fixed the retained-cloud-copy restart path and active sharing icon consistency. After `Stop Sharing`, the toolbar can start sharing again; the app resumes the same retained cloud copy instead of importing a new document, preserves the last shared projection baseline, and queues the current local Markdown for provider ingestion. The Sharing & Versions toolbar control now uses the same `link` icon in local and shared states, with only the active tint/background changing. | User manual-test report; `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`; `apps/marklab-macos/Sources/MarkLabMacOS/NativeSharedDocumentBindingStore.swift`; verification: `swift test --package-path apps/marklab-macos --filter MarkLabAppModelTests/restartSharingAfterStopResumesRetainedCloudCopy`; `swift test --package-path apps/marklab-macos --filter MarkLabNativeUIStrategyTests/sharingAndVersionsLabelsExplainRetainedCloudCopy`; `swift test --package-path apps/marklab-macos` returned 99 passed; `package:app`; `verify:package`; `git diff --check`. | Commit, push, and reinstall the rebuilt app for user retest. No hosted deploy is required because this fix is native-only. |
| 2026-05-27 | Gate 6 native embedded cursor/pill follow-up fixed the collaborator workflow split. Presence now stays three-layered: server session records online access, Yjs `user` awareness feeds collaborator lists, and source-pane cursor/pill rendering only occurs when the remote client publishes an explicit `cursor`. Same-name stale sessions are deduped across browser/app/unknown client-kind drift using awareness freshness, so the local app does not render multiple `Guest` pills for one collaborator. The embedded native WKWebView now uses a non-persistent data store and cache-bypassing navigation so it does not keep stale `/collab` bundles or IndexedDB state; the shared toolbar link icon receives an explicit active blue tint. | Runtime commit `37ecff0`; Fly release `v18`; image `registry.fly.io/marklab-relay-alpha:deployment-01KSMD8JH2G71P0ATZVZNJMFAX`; verification: `npx -y pnpm@10.0.0 exec vitest run packages/collab-editor/src/remote-cursors.test.ts`; `npx -y pnpm@10.0.0 exec vitest run apps/collab-web/src/App.test.tsx`; `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 test` returned 525 passed and 1 skipped; `swift test --package-path apps/marklab-macos` returned 99 passed; `npx -y pnpm@10.0.0 --filter @marklab/collab-web build`; `package:app`; `verify:package`; `git diff --check`; deployed health passed on default, IPv4, and IPv6; read-only and authenticated alpha smoke passed. | User retests in the freshly installed app: no editor pill before the browser collaborator clicks/types in the editor, one moving pill/caret after cursor placement, no duplicate stale `Guest` pills, and active sharing icon shows the same link symbol with blue active state. |
| 2026-05-28 | Gate 6 pre-manual-test native hardening closed the remaining local app blockers from the final smoke checklist. When a local file is open but the owner is signed out, Start Sharing and Open Shared Link now show a native Sign In Required prompt with a `Continue with Google` path instead of silently doing nothing or only writing status text. App launch restores persisted `syncEnabled` shared-document bindings into the menu-bar shared-document list, so previously shared files are visible across process restarts before reopening each document window. Sign-out now clears active shared sessions from the menu bar. Restarting sharing after Stop Sharing no longer opens conflict UI when the provider and local Markdown are already identical, and invalid `marklab://auth/callback` URLs are rejected as sign-in failures instead of falling through into shared-link handling. | User final Gate 6 smoke checklist; `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`; `apps/marklab-macos/Sources/MarkLabApp/MarkLabSharedSessionRestorer.swift`; `apps/marklab-macos/Sources/MarkLabMacOS/NativeSharedDocumentBindingStore.swift`; `apps/marklab-macos/Sources/MarkLabMacOS/NativeSharedDocumentSessionManager.swift`; verification: focused Swift tests for unsigned start-sharing prompt, unsigned shared-link prompt, persisted menu-bar session restore, sign-out session cleanup, and retained-cloud restart identical-provider result; `swift test --package-path apps/marklab-macos` returned 101 passed; `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package`; `git diff --check`. | Reinstall the rebuilt app after the currently running app can be closed, then run the interactive hosted Google/native callback/workspace/share/sign-out smoke. Gate 6 remains open until that manual smoke passes. |

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

## Gate 10.5 - Signed Distribution And Update Pipeline

Goal: make app distribution and updates reliable enough for broader beta/public or paid users.

Timing:

- Deferred for the small controlled pilot.
- Start after Gate 9 pilot evidence and after Gate 9.5 simplification decisions, unless pilot support pain makes manual updates a blocker earlier.
- Must pass before public/no-warning distribution, broader beta, or paid launch.

Checklist:

- [ ] Decide update channel:
  - [ ] manual versioned zip replacement for alpha;
  - [ ] Sparkle appcast or equivalent in-app updater;
  - [ ] Homebrew cask as an optional install channel.
- [ ] Implement Developer ID signing.
- [ ] Implement notarization.
- [ ] Produce versioned release artifacts with checksum and release notes.
- [ ] Verify old app to new app update preserves:
  - [ ] local files;
  - [ ] stored owner account;
  - [ ] workspace selection;
  - [ ] shared document bindings;
  - [ ] app support files;
  - [ ] browser links and cloud copies.
- [ ] Verify rollback/downgrade instructions.
- [ ] Document manual alpha update instructions until auto-update is implemented.
- [ ] Confirm docs do not imply auto-update during the small controlled pilot.

Progress log:

| Date | Update | Evidence | Next |
| --- | --- | --- | --- |
| 2026-05-23 | Gate added by product decision. App update pipeline is not part of Gate 6 and is not required before the controlled small pilot manual test. Gate 5 remains clean install only and explicitly does not claim paid/public distribution or auto-update semantics. | User decision; [`gate5-controlled-pilot-install.md`](./gate5-controlled-pilot-install.md) limitations. | Keep small pilot on manual replace-app updates; revisit after Gate 9 evidence before broader beta/public or paid launch. |

Exit criteria:

- A non-technical user can install/update without disabling Gatekeeper globally, or the beta limitation is explicitly accepted and bounded.
- Release artifacts are signed/notarized, or unsigned/ad-hoc distribution is limited to a named beta audience with written workaround instructions.
- Update/replace preserves account, workspace, local files, and shared-document bindings.
- Rollback instructions are tested.

## Gate 11 - Paid Billing And Pricing Launch

Goal: enable billing only after measured unit economics prove prices will not lose money.

Checklist:

- [ ] Use Gate 4 data to set no-loss floor.
- [ ] Pass Gate 10.5 distribution/update readiness before taking paid users.
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
| 2026-05-23 | Paid launch also depends on the new Gate 10.5 distribution/update pipeline. The small controlled pilot can proceed without auto-update, but paid users should not depend on ad-hoc unsigned app replacement. | Gate 10.5 added above. | Keep Stripe/paid flows disabled until real usage, support cost, and distribution/update evidence exist. |

Exit criteria:

- Paid plans are backed by real usage data and tested billing flows.
- No-loss floor and target margin are documented.
- Paid users have an accepted app installation/update path from Gate 10.5.

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
| 2026-05-21 | 2.5 | Expanded Gate 2.5 cleanup passed. | Removed old `apps/web`, daemon CLI helpers, API local/relay routes/services, native daemon boundary, and relay schema creation from active code; typecheck, root tests, Swift tests, package build, and package verification passed. | Fix non-judgment P1/P2 follow-ups from cleanup review before Gate 3. |
| 2026-05-21 | 2.5 | Fixed non-judgment Gate 2.5 P1/P2 follow-ups. | Native app shell marker no longer depends on bearer-token injection; malformed CLI request files no longer block later valid requests; P2-003 projection-ingestion failures now render as red operational status; stale active docs no longer present removed `apps/web`/daemon/local API targets as current acceptance paths. Verification: `swift test --package-path apps/marklab-macos`; `npx -y pnpm@10.0.0 typecheck`; `npx -y pnpm@10.0.0 test`; `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser`; `npx -y pnpm@10.0.0 --filter @marklab/collab-web test:e2e`; `package:app`; `verify:package`; `git diff --check`. | Discuss remaining judgment/visual P2 items before Gate 3: P2-002 cursor re-anchor latency and P2-004 dedicated conflict review surface. |
| 2026-05-22 | 2.5 | Fixed P2-004 native conflict review placement. | Conflict review moved from the collaboration inspector into the main editor surface with Diff/Local/Shared/Base/Resolved views and a sticky resolution action bar. The collaboration inspector now shows only a short conflict summary and a Review Conflict focus action. | P2-002 remains deferred; continue Gate 3 after visual spot-check if desired. |
| 2026-05-22 | 2.5 | Streamlined P2-004 conflict review IA after visual review passed. | Commit `51e55c4`: top-level conflict modes reduced to `Review` and `Manual Merge`; Review shows `Use Shared`/`Use Local`; Manual Merge moves the `APPLY RESOLVED` confirmation into the bottom action bar next to `Apply Manual Merge`. User visual review passed. | P2-002 remains deferred; Gate 3 can start. |

## Current Open Decisions

| Decision | Options | Owner | Needed by | Status |
| --- | --- | --- | --- | --- |
| RC SHA | Original `c1333b4e7a3a0d47ec6db2269bd97638b27de124`; patched code commit `cf3a2691a3601e946d01f3cfb3b67789ce08f31b` | TBD | Gate 0 | Decided for patched RC |
| Pilot auth path | OIDC vs invite-token bootstrap vs magic link | TBD | Gate 6 | Decided: OIDC owner login; browser guest links remain no-login. |
| Data retention | 30-day alpha retention vs shorter TTL | TBD | Gate 3 | Open |
| Provider backup | Fly snapshots only for alpha vs explicit off-volume backup | TBD | Gate 3 | Open |
| Free alpha caps | Workspace/doc/storage/session limits | TBD | Gate 11 | Deferred; Gate 4 only sets temporary pilot cost guardrails. |
| Dead code scope | Delete now vs archive only vs keep temporarily | TBD | Gate 2.5 | Decided: delete only confirmed unreferenced tracked files; keep active compatibility paths temporarily. |
| Pilot P2 timing | Fix before pilot vs defer | TBD | Gate 2.5 | Decided: fix small/testable P2 items before Gate 3 when product direction is clear. P2-003 and P2-004 fixed. P2-002 cursor re-anchor latency remains deferred for the small pilot. |
| Active simplification timing | Before pilot only for blockers vs after pilot evidence | TBD | Gate 9.5 | Deferred |
| App update pipeline | Manual zip replacement vs Sparkle/appcast vs Homebrew channel | TBD | Gate 10.5 | Deferred for the small controlled pilot; required before broader beta/public or paid launch. |
| Pilot size | 3-10 users vs 10-50 users | TBD | Gate 9 | Open |
| Paid launch timing | After small pilot vs after broader beta | TBD | Gate 11 | Deferred until Gate 4 bill/support evidence and Gate 10.5 distribution/update readiness. |

## Next Action

Complete Gate 6 with an interactive hosted Google login/native callback/workspace smoke, then continue Gate 7 security/privacy/ops evidence.

Next acceptance row: prove the deployed Google OIDC path opens MarkLab.app through `marklab://auth/callback`, persists the owner account, selects or creates a workspace, and allows sharing without exported owner-token env vars.
