# Sharing & Versions, Cloud Copy, And Version History Plan

Date: 2026-05-22
Gate: Gate 3 - Server/Data Lifecycle Audit
Baseline branch: `macos-app`
Baseline commit: `51e55c4 fix: streamline native conflict review UI`

## Goal

Make the shared-document lifecycle understandable and production-grade before pilot launch by separating four concepts that are currently too implicit:

- sharing/sync state;
- hosted cloud copy;
- online version history;
- local MarkLab support/cache data.

The user-facing model is:

- `Stop Sharing` stops sync and revokes active links, while keeping the hosted cloud copy and online version history.
- `Version History` is part of the hosted cloud copy and must be visible before destructive cloud deletion is user-facing.
- `Delete Cloud Copy` deletes hosted content and online version history, but never deletes the local Markdown file.
- `Clear Local MarkLab Data` clears this device/browser's MarkLab traces, but never deletes hosted content or local Markdown files.

## Current State

Native UI:

- The right toolbar has a `Collaboration` menu.
- In local-only state, that menu shows `Start Sharing`.
- In active sharing state, that menu shows `Sharing On`, `Stop Sharing`, `Create Edit Link`, `Create View Link`, and `Show Collaboration`.
- `Show Collaboration` toggles the right inspector.
- The inspector currently contains access links, active collaborators, local sync, Stop Sharing, and a conflict summary.

Version backend:

- `document_versions` stores Markdown snapshots, hashes, actor metadata, operation, parent version, version number, and creation time.
- API routes already exist for version list, show, manual save, autosave, and restore.
- Restore writes a new rollback version rather than mutating historical snapshots.
- Native hosted UI does not expose a complete Versions panel.

Deletion/local cleanup:

- Delete Cloud Copy API/UI now exists locally for deleting a cloud document/provider access/version history while keeping the local Markdown file.
- No complete product UI exists for clearing local MarkLab app/browser data.
- Cleanup jobs now exist for old grants, sessions, provider token audit rows, provider docs tombstoned by Delete Cloud Copy, stale browser edit-session storage, and completed native CLI handoff responses. Full user-facing `Clear Local MarkLab Data` remains a later app-settings/support action.

## Target IA

Preserve the existing two-step native pattern:

```text
Toolbar menu: Sharing & Versions

Local-only menu:
  Start Sharing

Active sharing menu:
  Sharing On
  Stop Sharing
  Create Edit Link
  Create View Link
  Show Sharing & Versions

Right inspector: Sharing & Versions
  Sharing
    Access Links
    Active Collaborators
    Local Sync
    Cloud Copy
  Versions
    Version list
    Selected version preview
    Restore confirmation
    Danger Zone

App Settings:
  Editing
    Autosave Local Files
  Privacy/Support/Reset
    Clear Local MarkLab Data
```

The inspector must open even for a local-only file. A user may need to restore from a retained cloud copy after sharing was stopped.

The inspector owns version preview/restore so the current article remains visible in the main editor while the user reviews past versions. Do not open a separate window or sheet for ordinary version history.

Document settings do not belong in the Sharing & Versions inspector. `Autosave Local Files` belongs in app-level Settings because it is an editor/app behavior for unshared files, not a cloud-copy or sharing lifecycle action.

`Clear Local MarkLab Data` does not belong in this document inspector. It belongs in app-level Settings under Privacy/Support/Reset.

Version creation should stay single-path:

- Browser and app clients both write the shared live Markdown through the active provider.
- Server-side provider autosave creates automatic online snapshots from that provider state, so browser-only sessions are included without a separate browser version UI.
- The native app adds manual controls: `Save Checkpoint`, `Cmd+S` manual checkpoint, and restore.
- Browser collaborators can edit and sync, but cannot yet browse or restore version history.

## Implementation Phases

### Phase 1 - Labels And Stop Sharing Help

Scope:

- Rename the toolbar menu label from `Collaboration` to `Sharing & Versions`.
- Rename `Show Collaboration` to `Show Sharing & Versions`.
- Rename the inspector title from `Collaboration` to `Sharing & Versions`.
- Add hover/help copy to every native `Stop Sharing` button:
  - "Stops sync and revokes active links. Cloud copy and version history are kept."
- Keep behavior unchanged.

Expected files:

- `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`
- Existing Swift UI strategy/model tests as needed.

Acceptance:

- Local-only toolbar menu still offers `Start Sharing`.
- Active sharing toolbar menu shows `Show Sharing & Versions`.
- Inspector title reads `Sharing & Versions`.
- Stop Sharing still flushes projection, revokes active grants, clears local binding/baseline, and keeps hosted content.
- No layout regression in the narrow inspector.

Testing:

- Swift tests for shell labels/help strings if practical.
- Existing native/browser smoke still passes.
- Visual check required only if label length or inspector width looks suspicious.

### Phase 2 - Cloud Copy Entry In Inspector

Scope:

- Allow `Show Sharing & Versions` when a local file is open even if sharing is not active.
- Remove the standalone toolbar `Document` menu that only contained autosave.
- Redesign the Sharing & Versions inspector around `Sharing` and `Versions` modes.
- Add `Autosave Local Files` to app-level Settings with copy that says it only applies when a file is not sharing; shared documents sync automatically and create online version checkpoints.
- Add a `Cloud Copy` section to the Sharing & Versions inspector.
- Show concise copy:
  - "Cloud copy and online version history are kept after Stop Sharing."
- Add a `Versions` mode skeleton in the same inspector, not a separate sheet.
- Record that true local-only cloud restore requires a retained cloud-copy reference/lookup path before restore can be functional after Stop Sharing.

Expected files:

- `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/MarkEditDocumentShellView.swift`
- `apps/marklab-macos/Tests/MarkLabMacOSTests/MarkLabNativeUIStrategyTests.swift` or `MarkLabAppModelTests.swift`

Acceptance:

- Local-only files can open the Sharing & Versions inspector.
- The current editor remains visible while the user opens the Versions mode.
- The standalone toolbar autosave menu is gone.
- `Autosave Local Files` is available from app-level Settings with sharing-specific explanatory copy.
- No destructive action is exposed yet unless backend support exists.

Testing:

- Swift tests for conditional inspector content.
- Manual/visual checkpoint after the redesigned inspector exists.

### Phase 3 - Native Version History Client

Scope:

- Add native API client methods for existing version routes:
  - list branch versions;
  - show selected version snapshot;
  - manual save;
  - autosave checkpoint;
  - restore selected version.
- Add a server-side provider autosave job that periodically reads active provider-backed branches and calls the same autosave persistence path.
- Keep API access tied to the existing hosted share controller/session context.
- Model errors explicitly for forbidden, unavailable, restore failure, and stale/missing version.

Expected files:

- `apps/marklab-macos/Sources/MarkLabMacOS/NativeControlPlaneShareClient.swift`
- `apps/marklab-macos/Sources/MarkLabMacOS/NativeHostedShareController.swift`
- `apps/marklab-macos/Tests/MarkLabMacOSTests/NativeControlPlaneShareTests.swift`
- `apps/api/src/services/provider-autosave-service.ts`
- `apps/api/src/services/provider-autosave-service.test.ts`

Acceptance:

- Native can list versions for the current shared doc/branch.
- Native can fetch a selected snapshot without applying it.
- Manual save flushes active collaboration state through the existing API route.
- Opening or refreshing version history can create an automatic checkpoint when the shared state changed.
- Manual/autosave checkpoints use the active provider snapshot when the provider is newer than the stored DB mirror.
- Browser-only and app-only writes are both captured by server-side provider autosave; clients do not implement duplicate versioning rules.
- `Cmd+S` in shared native mode creates a manual checkpoint.
- Restore calls the existing restore route and reports the new rollback version.
- Restore writes the rollback Markdown back into the active provider before native editor reload.
- View-only/public view sessions cannot manage versions.

Testing:

- Swift HTTP transport tests for list/show/save/restore paths.
- Existing API version route tests remain authoritative for backend semantics.

### Phase 4 - Version History UI

Scope:

- Fill the Sharing & Versions inspector's `Versions` mode.
- Include:
  - `Save Checkpoint` for an explicit manual checkpoint;
  - `Cmd+S` parity with `Save Checkpoint`;
  - version list ordered newest first;
  - version rows named with local file name plus timestamp;
  - selected version metadata with operation/checkpoint type;
  - Markdown preview or plain source preview;
  - `Restore This Version` with confirmation.
- Explain restore semantics in confirmation:
  - restoring creates a new current rollback version;
  - old snapshots are kept;
  - the local Markdown file will receive the restored shared state through normal projection.

Acceptance:

- User can inspect online version history without leaving the native app.
- Version history is automatic by default, with a manual checkpoint button for intentional milestones.
- User can preview before restore.
- User cannot accidentally restore with one stray click.
- After restore, active app/browser collaborators receive the restored state.
- The local file projection behavior remains conflict-safe.
- Save/restore behavior is verified against the active provider state, not only mocked native API calls.

Testing:

- Swift model/client tests for successful and failed actions.
- Existing API tests for restore still pass.
- Native/browser smoke for shared app + browser after restore.
- Visual checkpoint required for sidebar readability and restore confirmation.

### Phase 5 - Delete Cloud Copy Backend

Status: implemented, deployed, and hosted-smoke verified for Gate 3. An operator-only cleanup fallback is no longer sufficient for the pilot gate.

Scope:

- Add an owner/manage-access-only deletion or tombstone API.
- Decide final server implementation before coding:
  - hard delete rows immediately; or
  - tombstone document first, then async cleanup provider state.
- Required behavior:
  - revoke all active grants;
  - close or expire active access/collab sessions;
  - prevent provider-token refresh after deletion;
  - delete or queue deletion for Y-Sweet provider state;
  - remove hosted Markdown snapshots/current state according to policy;
  - keep local Markdown files untouched.

Expected files:

- `apps/api/src/routes/*`
- `apps/api/src/services/*`
- `apps/api/src/db/schema.sql` if tombstone columns are needed.
- Provider tombstone/cleanup code for denying future provider access plus tombstone-driven physical provider-store cleanup for known direct-child Y-Sweet provider directories.

Acceptance:

- Deleted cloud copy cannot be reopened by old edit/view links.
- Deleted cloud copy cannot refresh provider tokens.
- Browser/app sessions see a terminal unavailable state.
- Local Markdown file remains on disk and editable locally.
- Provider state is deleted or recorded as pending cleanup with an auditable path.

Testing:

- API route tests for owner-only delete, link revocation, token refresh denial, and local-file non-involvement.
- Provider cleanup/orphan tests if provider deletion is implemented.
- E2E smoke for old link after deletion.

### Phase 6 - Delete Cloud Copy UI

Status: implemented, deployed, and hosted-smoke verified for Gate 3.

Scope:

- Add `Delete Cloud Copy` under `Sharing & Versions` -> `Versions` -> `Danger Zone`.
- Require explicit confirmation.
- Confirmation copy must say:
  - hosted copy and online version history will be deleted;
  - active links/sessions will stop working;
  - local Markdown file stays on disk.
- After success, the app should return to local-only mode if it was sharing that deleted cloud copy.

Acceptance:

- Destructive action is not visible as a casual inspector button.
- User must intentionally enter the wider sheet and confirm.
- Success and failure states are clear.
- Stop Sharing remains a separate non-destructive action.

Testing:

- Swift UI/model tests for confirmation state and post-delete local-only state.
- Manual visual checkpoint for danger-zone clarity.

### Phase 7 - Clear Local MarkLab Data

Scope:

- Add app-level Settings or Support/Privacy action, not document inspector UI.
- Clear native app support data that MarkLab owns:
  - shared-document bindings;
  - projection baselines;
  - conflict copies;
  - CLI request/response handoff files;
  - local token/session traces where safe.
- For browser data, either provide a self-cleaning route for localStorage/IndexedDB or document browser site-data clearing as a support action.

Acceptance:

- Local Markdown files are never deleted.
- Hosted cloud copies and online version history are never deleted.
- App can restart cleanly after local data cleanup.
- Active sharing state handles cleanup with either refusal, warning, or required Stop Sharing first.

Testing:

- Swift app-support store tests.
- Browser storage tests if browser self-cleanup is implemented.
- Manual support-flow check if OS/browser settings are involved.

### Phase 8 - Cleanup Jobs And Restore Drill

Status: scheduled lifecycle cleanup implemented for Gate 3; full Neon/Fly infrastructure restore drill remains deferred to the final launch gate.

Scope:

- Implement autosave-version retention:
  - manual/import/create/rollback checkpoints are protected from automatic pruning;
  - autosaves inside the latest 30 days of the branch edit timeline are kept;
  - current wall-clock time is not used as the retention anchor;
  - pruning only deletes `operation = 'autosave'` rows and must never advance or corrupt branch head state.
- Add scheduled cleanup for:
  - expired/used OIDC states;
  - expired/revoked user sessions;
  - revoked/expired access grants after retention window;
  - expired collab sessions and provider token audit rows;
  - native completed CLI responses;
  - stale browser localStorage/IndexedDB entries where possible;
  - provider orphans created by Delete Cloud Copy.
- Move the full Neon/Fly provider restore drill to the final launch gate.

Acceptance:

- Retention windows are explicit.
- Cleanup jobs are idempotent.
- Restore drill is explicitly tracked in the final launch gate.
- Cost instrumentation can rely on bounded storage categories.
- Gate 3 hosted lifecycle smoke confirms provider-backed version creation, restore, Delete Cloud Copy, old grant denial, old provider-token refresh denial, provider tombstone denial, and post-delete versions denial.

## Visual Checkpoints

Stop and ask for manual visual review after:

- Phase 1 if `Sharing & Versions` label length looks awkward in the toolbar menu.
- Phase 2 when the redesigned `Sharing / Versions` inspector and app-level `Autosave Local Files` setting exist.
- Phase 4 when version list/preview/restore confirmation are visible.
- Phase 6 when `Delete Cloud Copy` danger-zone UI is visible. The destructive action has Swift UI/model coverage and hosted lifecycle smoke; a final manual visual spot-check can be done from the packaged app before inviting pilot users if desired.

Do not ask for visual review for backend-only route/client/test changes.

## Exit Criteria

Gate 3 can pass for a small manual pilot when:

- `Stop Sharing` behavior and copy clearly say the cloud copy/version history are kept.
- Version History is inspectable from native UI or deliberately deferred with pilot wording.
- `Delete Cloud Copy` is implemented and tested as a self-serve destructive cloud-copy action.
- Autosave-version retention is implemented and tested: manual/import/create/rollback checkpoints stay protected, while old autosave rows are bounded by the latest 30 days of each branch's edit timeline.
- `Clear Local MarkLab Data` is either implemented or covered by support wording with no false privacy promise.
- Restore drill is tracked for the final launch gate.
- Public docs do not claim cloud deletion, local cleanup, or version-history UI beyond what exists.

Paid/public launch requires:

- self-serve cloud deletion or legally/product-approved retention wording;
- restore drill evidence;
- workspace/account deletion promises to be implemented or explicitly excluded from public/privacy wording;
- version retention/storage policy;
- pricing model that accounts for retained stopped-sharing cloud copies and version snapshots.
