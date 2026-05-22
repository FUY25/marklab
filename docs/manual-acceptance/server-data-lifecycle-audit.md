# Gate 3 Server/Data Lifecycle Audit

Date: 2026-05-22
Baseline branch: `macos-app`
Baseline commit: `7f47410 feat: add shared version autosave`

This audit is for the pre-pilot launch gate. It records what MarkLab stores locally and remotely, what deletion/revocation does today, and what is still missing before a broader launch or paid billing.

## Gate Verdict

Gate 3 passes for the small manual pilot with clear operator expectations. The lifecycle story is good enough for 3-10 controlled users, but it is not yet sufficient for broad public launch or paid billing.

Implemented now:

- The active pilot stack is the hosted control-plane/Y-Sweet path, not the archived daemon/local relay path.
- Shared documents are persisted in Neon Postgres and the Y-Sweet provider store on the Fly volume.
- Native app local bindings, projection baselines, conflicts, and CLI handoff files are written under the user's MarkLab Application Support directory with `0600` file permissions.
- Access grants and share links are revoked by setting `revoked_at`, and provider-token refresh denies revoked/expired grants.
- `Stop Sharing` flushes pending shared projection, revokes currently listed active links when possible, clears the native binding/baseline for that local file, and returns the native window to local-only mode.
- The native `Sharing & Versions` inspector exposes inline Sharing and Versions modes. Shared documents can list, preview, manually checkpoint, and restore online versions from the app.
- Browser and native edits write the active Y-Sweet provider state. Manual checkpoints and autosave checkpoints read that live provider state, and restore writes the selected version back into the provider before the app/browser continue.
- A server-side provider autosave job periodically creates online version checkpoints for provider-backed branches after a quiet period, so browser-only shared edits are captured even though the browser has no version UI.
- Browser edit sessions persist reload metadata in localStorage and Yjs state in IndexedDB under keys scoped by document/provider/session identity.

Missing or not fully implemented:

- No API/UI path was found for hard-deleting a cloud document, workspace, or account.
- No scheduled cleanup job was found for expired/revoked grants, expired sessions, old provider-token rows, stale OIDC states, inactive provider docs, old versions, browser IndexedDB entries, or completed CLI response files.
- No implemented provider-document delete/orphan cleanup path was found for `/data/ysweet`.
- Backup/restore guidance exists in the production runbook. Hosted version restore into provider state has been tested on the deployed alpha, but a full Neon/Fly infrastructure restore drill and concrete alpha RPO/RTO are still pending before more than 10 users.
- Public/privacy wording has been corrected for the current Stop Sharing behavior; it still should not promise full cloud deletion or automatic cleanup until those paths exist.

Pilot recommendation:

- Accept for a small manual pilot if operators explicitly treat cloud copies as retained until manual cleanup, do not promise account/document deletion SLAs, and run the full Neon/Fly restore drill before inviting more than 10 users.
- Do not enter paid launch until cloud deletion semantics, cleanup jobs, and restore drill evidence are implemented or deliberately scoped into product/legal wording.

Accepted product model:

- `Stop Sharing` stops active sharing/sync for the local file and revokes active links. It does not delete the hosted copy, online version history, provider state, or local Markdown file.
- `Version History` is part of the hosted cloud copy. The backend stores version snapshots and the native app exposes version list/show/manual checkpoint/restore controls for shared documents. Browser collaborators participate in version history through shared provider writes and server-side autosave, but they do not have version controls.
- `Delete Cloud Copy` is a separate destructive document action for deleting the hosted document, online version history, access grants, collaboration sessions, and provider state. It must never delete the local Markdown file.
- `Clear Local MarkLab Data` is a separate device/browser privacy and reset action for removing local MarkLab support data, browser caches, handoff files, local tokens/session metadata, baselines, and conflict copies. It must not delete hosted documents or local Markdown files.
- The product should describe shared documents as local-file-first documents with a hosted cloud copy, not as a purely temporary relay room.

UI placement recommendation:

- Preserve the current native toolbar-menu pattern. The right-side toolbar menu should be renamed from `Collaboration` to `Sharing & Versions`; it should not directly open the inspector.
- In local-only state, the `Sharing & Versions` toolbar menu should primarily show `Start Sharing`.
- In active sharing state, the menu should keep quick actions such as `Stop Sharing`, `Create Edit Link`, and `Create View Link`, and rename `Show Collaboration` to `Show Sharing & Versions`.
- Keep `Stop Sharing` in the Sharing & Versions inspector because it is the normal per-document sharing state action.
- Add a small hover-only explanation on `Stop Sharing`: "Stops sync and revokes active links. Cloud copy and version history are kept." This keeps the primary UI quiet while making the retention behavior discoverable.
- Put `Version History` inline in the Sharing & Versions inspector so users can compare the current document and prior versions without leaving the editor.
- Keep `Delete Cloud Copy` out of the normal Sharing tab. When implemented, it belongs in a destructive document Danger Zone with explicit confirmation that the local Markdown file stays on disk.
- Put `Clear Local MarkLab Data` in app-level Settings under Privacy/Support/Reset, not in the document Collaboration inspector. It is device/account-local cleanup, not a sharing action for the current document.

Execution plan:

1. Product wording and docs: lock the three-action model in lifecycle, privacy, and user-guide docs.
2. Toolbar/menu IA: rename the current `Collaboration` toolbar menu to `Sharing & Versions` and rename its active-state `Show Collaboration` item to `Show Sharing & Versions`.
3. `Stop Sharing` UI: add hover/help microcopy and a lightweight confirmation only if the implementation needs one; current behavior should continue retaining the cloud copy.
4. `Version History` UI: completed inline in the Sharing & Versions inspector with list, selected-version preview, manual checkpoint, restore confirmation, and clear copy that restore writes a new rollback version rather than mutating old snapshots.
5. `Delete Cloud Copy` backend: before public launch, add an owner-only document deletion/tombstone API, revoke grants, close or expire sessions, delete/queue provider-state cleanup, and preserve audit rows only according to the retention policy.
6. `Delete Cloud Copy` UI: before public launch, add a destructive document Danger Zone entry with explicit confirmation and success/error states.
7. `Clear Local MarkLab Data` native/browser cleanup: before public launch, add a support/settings action for app support files and browser site data guidance or self-cleanup where technically possible.
8. Cleanup jobs: before broad launch or paid billing, add scheduled cleanup for expired/revoked grants, sessions, token audit rows, stale local handoff files, stale browser IndexedDB/localStorage entries, and provider orphans created by deleted cloud copies.
9. Backup/restore drill: before more than 10 users, record Neon and Fly provider restore evidence.
10. Tests: before public launch, prove `Stop Sharing` retains hosted content, `Delete Cloud Copy` removes hosted content without touching local disk, and `Clear Local MarkLab Data` removes local traces without touching cloud content. Version History list/show/manual-save/restore has deployed API/UI coverage.

## Evidence Checked

- Schema and retention fields: `apps/api/src/db/schema.sql`
- Document import/create: `apps/api/src/routes/import-export-routes.ts`, `apps/api/src/services/doc-create.ts`
- Access grants and revocation: `apps/api/src/routes/access-routes.ts`
- Collab sessions and provider-token refresh: `apps/api/src/routes/collab-session-routes.ts`, `apps/api/src/services/provider-doc-service.ts`
- Auth sessions: `apps/api/src/services/user-service.ts`, `packages/shared/src/provider-token-policy.ts`
- Billing usage: `apps/api/src/services/billing-service.ts`
- Native app stores: `apps/marklab-macos/Sources/MarkLabMacOS/NativeAppSupportDirectory.swift`, `NativeSharedDocumentBindingStore.swift`, `NativeCollaborationRuntime.swift`, `NativeConflictStore.swift`, `NativeCLIShareBridge.swift`
- Native Stop Sharing behavior: `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`
- Browser local storage: `apps/collab-web/src/api/edit-session-storage.ts`, `apps/collab-web/src/editor/CollaborativeMarkdownEditor.tsx`, `packages/collab-editor/src/ytext-codemirror.ts`
- Fly provider storage: `fly.toml`
- Production docs: `docs/production/alpha-launch-runbook.md`, `docs/production/privacy-and-storage.md`, `docs/production/relay-ops.md`
- Cleanup search: `rg -n "cron|schedule|setInterval|cleanup|retention|purge|expired|stale" apps/api/src scripts infra .github -g '!**/*.test.ts'`
- Hard-delete search: `rg -n "delete from documents|delete from document_branches|delete from document_branch_states|delete from document_versions|delete from document_access_grants|delete from collab_sessions|delete from provider_token|is_archived = true|set is_archived" apps/api/src -g '!**/*.test.ts'`

## Storage Map

| Surface | Location | Stored data | Contains raw Markdown/content? | Current retention/deletion behavior | Gap |
| --- | --- | --- | --- | --- | --- |
| User Markdown file | User-selected local disk path | The opened or joined `.md` file | Yes | MarkLab edits the file while open. Cloud revocation and Stop Sharing must not delete it. User/OS controls deletion. | Need public wording to keep saying local file deletion is user-controlled. |
| Native shared binding | `~/Library/Application Support/MarkLab/shared-document-bindings.json` or `MARKLAB_APP_SUPPORT_DIR` override | File path, doc id, branch id, mode, app editor URL, local doc id, baseline hash, optional raw access token | No Markdown, but may include a raw token and local path | Written with `0600`. Cleared for the local file on Stop Sharing. Otherwise retained until app clears it or user removes app support data. | Add "remove all local MarkLab app data" support command later. Avoid storing raw token long-term if not required. |
| Native projection baseline | `~/Library/Application Support/MarkLab/projection-baselines.json` | Last projected Markdown, hash, provider fingerprint, timestamp keyed by local path | Yes | Written with `0600`. Cleared for the local file on Stop Sharing. Updated during normal sync. | No age cleanup. Contains a local content copy. |
| Native conflict files | `~/Library/Application Support/MarkLab/conflicts/*.json` | Local/shared/base Markdown, hashes, shared fingerprint, editor URL, status | Yes | Written with `0600`. Cleared when conflict is resolved or file-specific conflict is cleared. | No age cleanup for unresolved or abandoned conflicts. |
| Native CLI request/response files | `~/Library/Application Support/MarkLab/cli-requests/*.json`, `cli-responses/*.json` | File path, action, role, join/share link, hosted API/web URLs, bearer token in hosted config, response URL/grant ids/errors | Usually no Markdown, but can include raw bearer token or share link | Written with `0600`. Pending request scan removes stale pending/malformed requests after 600 seconds. Completed responses can remain. | Add cleanup for completed responses and avoid durable bearer token handoff if possible. |
| Native session manager | Process memory | Active native shared document list/status | No | In-memory only. Lost when app exits. | No issue for retention, but app support binding is the durable source. |
| Browser localStorage | Browser origin `https://marklab-relay-alpha.fly.dev` | Edit session id, refresh token, provider doc id, route token hash, updatedAt | No Markdown, but includes refresh token | Cleared when terminal refresh/revocation marks editor unavailable. Otherwise retained by browser until overwritten or user clears site data. | Add TTL cleanup and "clear site data" support wording. |
| Browser IndexedDB | Browser origin, y-indexeddb key `marklab:collab-web:<providerDocId>:<sessionId>` | Yjs document cache for reload persistence | Yes, document content in Yjs form | Destroyed for the active component lifecycle, but no explicit site-wide stale IndexedDB cleanup was found. User can clear site data. | Add stale IndexedDB cleanup keyed by session/grant expiry. |
| Neon auth tables | `users`, `user_sessions`, `oidc_login_states` | User identity, hashed session tokens, OIDC state verifier, expiry/revocation timestamps | No | User sessions default to 30 days. OIDC states default to 10 minutes. Logout/rebootstrap can mark sessions revoked. | No scheduled purge of expired/revoked rows. No account deletion path found. |
| Neon workspace/billing tables | `workspaces`, `workspace_members`, `workspace_share_keys`, `workspace_folders`, `folder_access_policies`, `plans`, `seat_limits`, `subscriptions` | Workspace ownership/membership, share-key hashes, manual/Stripe billing metadata, seat limits | No | FK cascades clean some child rows if a workspace is deleted directly in DB. App-level workspace deletion path not found. | Account/workspace delete semantics and billing retention need implementation before paid launch. |
| Neon document state | `documents`, `document_branches`, `document_branch_states` | Document/branch metadata, current Markdown, current Yjs state, hashes, provider doc id/seed state | Yes | Created on Start Sharing/import. Cascades if document row is hard-deleted in DB, but no app/API hard-delete path found. Branches can be flagged `is_archived`, but no active archive route found. | Define product delete/archive and provider-store cleanup. |
| Neon versions | `document_versions` | Saved version Markdown snapshots, hashes, actor ids, operation, version number | Yes | Created on import/create and version save/flush flows. Retained indefinitely today unless parent document is hard-deleted in DB. | Add retention/compaction policy before high-volume usage. |
| Neon access grants/sessions | `document_access_grants`, `document_access_sessions`, legacy `agent_tokens`, legacy `share_links` | Hashed access tokens, role, expiry/revocation, client presence metadata | No raw Markdown | Revoke sets `revoked_at`. Listing hides revoked grants. Access verification rejects expired/revoked grants. Sessions track last seen. | No purge job. Legacy tables still exist for compatibility but active grants use `document_access_grants`. |
| Neon collab token audit | `collab_sessions`, `provider_token_issuances`, `provider_token_refreshes` | Session ids, refresh token hashes, client kind, actor/grant ids, issuance status, provider errors, expiry/deny reasons | No raw Markdown | Edit provider tokens default to 10 minutes and refresh. Active collab sessions get `expires_at`; refresh denies revoked/expired/forbidden states. | No close/purge job for expired sessions or old token rows. |
| Fly provider volume | Fly volume `marklab_ysweet_data` mounted at `/data`, store path `/data/ysweet` | Y-Sweet provider document state/checkpoints | Yes, document content in Yjs form | Provider process stores state with checkpoint frequency configured as 10 seconds. Fly app keeps at least one machine running. Rollback does not roll back this volume. | No provider doc delete/orphan cleanup. Snapshot schedule/restore drill not captured in repo. |
| Fly/API logs | Fly logs and local operator logs | Request paths, errors, status, possibly operational metadata | Should not contain raw tokens or Markdown | Runbooks warn not to expose secrets. Token proxy strips cookies to provider. | Need log audit before paid launch to prove no raw tokens/local paths/content in logs. |
| Bootstrap/operator files | Operator machine temp files from `scripts/marklab-bootstrap-alpha-user.mjs` | Alpha owner token JSON if operator saves output | No Markdown, but includes raw user token | Runbook says create temp file with `0600` and do not commit/share. | Operator discipline only; add cleanup reminder to launch checklist. |

## Document Lifecycle

### Local-only file

- The native app opens and saves the user's `.md` file directly.
- No hosted document is created unless the user starts sharing or joins a hosted link.
- If the file was previously shared, native app support data may still exist until Stop Sharing or local app data cleanup clears it.

### Start Sharing

- Native app saves the local file first.
- `NativeHostedShareController.startSharing` reads the local Markdown and calls the control-plane import path.
- The API creates:
  - `documents`
  - `document_branches`
  - `document_branch_states` with `current_markdown`, `current_hash`, `yjs_state`, and `yjs_state_fingerprint`
  - first `document_versions` row
- Native app writes shared binding and projection baseline in Application Support.
- Provider doc id is created lazily when a collab session needs Y-Sweet. The provider doc id is stored in `document_branch_states.provider_doc_id`, and Y-Sweet persists the provider state under `/data/ysweet`.

### Active shared document

- Native app projects provider changes back to the local file and stores projection baselines.
- Browser/app collaborators create collab sessions and provider-token issuances.
- Browser clients persist edit-session refresh metadata in localStorage and a Yjs cache in IndexedDB.
- Saved versions and export paths can flush live provider state back to Neon.

### Version History

- Backend data exists in `document_versions`, including Markdown snapshot, hash, actor type/id, operation, parent version, version number, and creation time.
- API routes exist for listing branch versions, showing one version snapshot, manual save, autosave, and restoring a version onto the active branch.
- Restore creates a new rollback version and applies restored state through the live writer/provider path; existing historical snapshots are not mutated.
- Native shared documents expose an inline Versions panel with manual checkpoint, version list, selected snapshot preview, and guarded restore.
- Browser collaborators do not have version controls, but their edits are part of the shared provider state and are captured by server-side autosave checkpoints.
- Product decision: Version History is now visible before `Delete Cloud Copy` becomes user-facing, because Delete Cloud Copy deletes the hosted copy and online history users can otherwise inspect and restore from.

### Revoke link

- Active access grants are revoked by setting `document_access_grants.revoked_at`.
- Existing provider-token refreshes deny revoked/expired grants and move the editor to Unavailable/read-only behavior.
- Deleting/revoking a grant does not delete:
  - local Markdown files;
  - hosted document rows;
  - version snapshots;
  - provider document state;
  - unrelated grants/sessions.

### Stop Sharing

- Native app refuses Stop Sharing while a conflict is open.
- It flushes pending shared projection first.
- It asks the server for currently listed access links and revokes active ones it can manage.
- It cancels projection, clears local binding and projection baseline for that file, removes the native shared-session entry, and returns the file to local-only editing.
- It does not delete the hosted document, provider state, version history, or local Markdown file.
- Current implementation asks the server for active grants before Stop Sharing. After relaunch, older links may not have copyable URLs because raw tokens are not stored, but revoke works by grant id. If the server list fails, the app falls back to in-memory links from the current app session.

Product decision: `Stop Sharing` should keep this non-destructive behavior. The UI should explain this with hover/help copy instead of making the primary Collaboration inspector heavier.

### Delete Cloud Copy

- Not implemented yet as a user-facing product action.
- This should be the destructive cloud-content action, separate from Stop Sharing.
- It should delete or tombstone the hosted document, online version history, access grants, access/collab sessions, and provider document state.
- It should keep the local Markdown file on disk.
- It should live in document Settings/Danger Zone with explicit confirmation.
- Minimum pilot fallback before implementation: operator-only cleanup runbook with exact Neon and provider-store steps, plus a warning that this is not self-serve.
- Current pilot fallback: do not promise self-serve Delete Cloud Copy. If a pilot user requests hosted-content deletion, treat it as an operator support task: revoke links first, confirm the local Markdown file is preserved, take any required export/backup, then perform scoped manual database/provider cleanup outside the product UI. This must become a proper API/UI path before public launch.

### Clear Local MarkLab Data

- Not implemented yet as a complete user-facing product action.
- This should remove local MarkLab traces for the device/browser: native app support files, projection baselines, conflict copies, CLI handoff files, local tokens/session metadata, browser localStorage, and browser IndexedDB caches.
- It should not delete hosted documents, online version history, active grants, or the user's Markdown files.
- It should live in app Settings under Privacy/Support/Reset, not in the document Collaboration inspector.
- Current pilot fallback: there is no one-click self-serve reset. Operators can guide the user to Stop Sharing for each shared local file, quit MarkLab, remove MarkLab Application Support data for the relevant profile, and clear browser site data for the hosted origin. This does not delete hosted documents or the user's Markdown files.

### Document deletion

- No active API/UI route was found for deleting a cloud document.
- If an operator directly deletes a `documents` row in Neon, many child rows cascade by schema. This is not a product deletion path and does not clean the Y-Sweet provider volume by itself.
- For pilot, treat hosted documents as retained until an operator performs a documented manual cleanup.

### Workspace deletion

- No active API/UI route was found for deleting a workspace.
- Schema cascades some workspace-owned metadata if a workspace row is directly deleted, while `documents.workspace_id` is `on delete set null`.
- This means direct workspace deletion would orphan documents instead of deleting them.
- For pilot, do not use workspace deletion as a document/content deletion mechanism.

### Account deletion

- No active API/UI route was found for deleting a user/account.
- Schema cascades user sessions and workspace memberships if a user row is directly deleted, but owned workspaces set `owner_user_id` to null and documents do not automatically delete through user removal.
- Account deletion needs a product/legal decision before public launch.

### Local file missing/deleted

- Current privacy/storage docs say the app should pause projection and surface local sync state; it must not silently recreate or overwrite the missing path.
- Existing manual acceptance already covered missing local file/projection error visibility. This lifecycle audit does not require re-running that visual phase unless behavior changes.

## Retention Policy Draft

This is the policy that matches the current implementation closely enough for manual pilot.

| Data class | Pilot retention | Deletion action today | Launch gap |
| --- | --- | --- | --- |
| Local Markdown file | Until user deletes it | User/OS deletion only | None, but wording must stay clear. |
| Native shared bindings | Until Stop Sharing or local app data cleanup | Stop Sharing clears current file binding | Add all-local-data cleanup/support command. |
| Native baselines/conflicts | Until resolved/Stop Sharing/local cleanup | Conflict resolution clears conflict; Stop Sharing clears baseline | Add stale conflict/baseline cleanup. |
| Native CLI request/response files | Pending requests cleaned after 600 seconds when scanned; responses retained | Pending scan removes stale pending/malformed requests | Add completed-response cleanup and reduce durable raw-token exposure. |
| Browser localStorage edit sessions | Until terminal unavailable state or user clears site data | Terminal refresh/revocation clears current session entry | Add TTL/stale cleanup. |
| Browser IndexedDB Yjs cache | Until browser clears site data or app implements cleanup | No explicit stale cleanup found | Add cleanup keyed by session/grant expiry. |
| User sessions | 30 days by default, or revoked by logout/bootstrap rotation | `revoked_at` set on logout/rotation | Purge expired/revoked rows later. |
| OIDC login state | 10 minutes by default | Used states marked `used_at` | Purge expired/used rows later. |
| Access grants/share links | Until revoked/expired; rows retained | Revoke sets `revoked_at` | Purge or archive policy needed. |
| Access sessions/collab sessions | Rows retained; active checks use expiry/last_seen/status | No hard cleanup found | Add session close/purge job. |
| Provider-token issuances/refreshes | Rows retained as audit trail | Status/deny reason updated | Add retention window, likely 30-90 days for alpha audit. |
| Document current state | Retained while cloud document exists | No product delete path found | Implement document delete/archive and provider cleanup. |
| Versions | Retained indefinitely during pilot | No version purge found | Define compaction/deletion before high-volume usage. |
| Provider Y-Sweet docs | Retained while provider volume exists | No product provider delete path found | Implement provider doc cleanup and orphan detection. |
| Billing metadata | Retained in Neon | Manual mode currently | Stripe/legal retention must be defined before paid launch. |
| Logs | Operational retention controlled by Fly/local tools | No repo-controlled cleanup | Audit logs for token/path/content leakage. |

## Deletion Semantics

For manual pilot, use these semantics in user-facing and operator language:

- Revoke link: disables that grant for future joins/refreshes. It does not delete content.
- Stop Sharing: stops this native file's active sharing/sync state and revokes currently manageable active links. It keeps the hosted copy and online version history.
- Delete local file: deletes only the user's local disk file. It does not delete hosted document/provider/version state.
- Delete Cloud Copy: not implemented as a product action yet. When implemented, this is the action that deletes hosted document/provider/version state while preserving the local Markdown file.
- Delete workspace: not implemented as a product action yet, and direct DB workspace deletion would not delete documents.
- Delete account: not implemented as a product action yet, and direct DB user deletion would not delete all related content.
- Clear browser site data: removes browser localStorage/IndexedDB copies for that browser profile. It does not delete hosted content.
- Clear native app support data / Clear Local MarkLab Data: removes local MarkLab metadata, tokens/session traces, handoff files, baselines, and conflict copies for that Mac/browser user. It does not delete hosted content.

## Backup And Restore

What is in place:

- The runbook states that image rollback does not roll back Neon or provider persistence.
- The runbook tells operators not to delete the Fly volume during rollback.
- The runbook requires schema readiness before deploy and `/healthz` readiness for database/schema/provider/store.
- The runbook documents a production persistence smoke: write a marker, restart the Fly machine, reopen the edit link, and confirm provider state persists from `/data/ysweet`.

Current Gate 3 restore evidence:

- On 2026-05-22, deployed Fly alpha release `v12` at commit `7f47410cf8ba4c19a73c7bf725995722675b5560`.
- Hosted provider-version smoke created disposable doc `1a600b8a-7e77-4af7-b579-d0f422c909e7`, wrote a marker through a real Y-Sweet websocket, confirmed export read the live provider marker, manual-saved version 2, restored the initial version as version 3, and confirmed export returned restored provider state.
- `/healthz` after deploy returned `ok: true` with database, schema, provider, and provider store ready.

What is not yet sufficient:

- Exact Neon backup tier, PITR window, and restore command are not captured in repo.
- Exact Fly volume snapshot schedule and restore procedure are not captured in repo.
- No full Neon PITR/Fly volume restore drill result is recorded for this gate.
- No final alpha RPO/RTO is approved beyond the manual-pilot posture: hosted version restore is verified; infrastructure restore must be treated as manual recovery until tested.

Minimum before more than 10 users:

- Record current Neon backup/PITR capability for `DATABASE_URL`.
- Record current Fly volume snapshot/fork capability for `marklab_ysweet_data`.
- Run a full infrastructure restore drill on a disposable doc:
  - create shared document;
  - write marker from app/browser;
  - confirm marker in Neon snapshot/export and provider state;
  - restore to a staging clone or disposable provider volume;
  - confirm browser/app can read expected restored marker.
- Set alpha RPO/RTO target. Suggested pilot default: RPO 24 hours, RTO 1 business day, with explicit "manual recovery" wording.

## Cleanup Jobs Needed

These are not blockers for a tiny manual pilot, but they should be implemented before broad launch or paid billing.

| Priority | Cleanup job | Suggested initial policy | Reason |
| --- | --- | --- | --- |
| P1 | Expired OIDC states | Delete used/expired states older than 1 day | Reduces auth table noise and verifier retention. |
| P1 | Expired/revoked user sessions | Delete or archive revoked/expired sessions older than 30-90 days | Keeps auth table bounded. |
| P1 | Revoked/expired access grants | Retain metadata for 30-90 days, then purge token hashes and sessions | Keeps audit short while limiting token-hash retention. |
| P1 | Expired collab sessions and provider token rows | Retain issuance/refresh audit for 30-90 days | Bounds high-churn collaboration rows. |
| P1 | Native CLI completed responses | Delete completed responses older than 1 day | Reduces raw link/token exposure on local disk. |
| P2 | Browser localStorage/IndexedDB stale entries | Clear entries after grant/session terminal state or 7-30 days idle | Reduces content copies in browser profile. |
| P2 | Native unresolved conflicts/baselines | Surface and optionally delete stale unresolved local support copies after user confirmation | Avoids hidden local content copies. |
| P2 | Inactive provider docs | Detect provider_doc_id rows with no active grants/sessions and archived/deleted documents | Requires product delete/archive semantics first. |
| P3 | Old version snapshots | Keep all during pilot; later compact by age/count/plan | Needs product version-history promise and billing model. |

## Open Decisions For Gate 3 Exit

| Decision | Default for manual pilot | Must be decided before |
| --- | --- | --- |
| Do we promise cloud document deletion? | No. Hosted content is retained until manual operator cleanup. | Public launch. |
| Do we promise account deletion? | No self-serve promise. Handle manually if needed. | Public launch / privacy terms. |
| How long do shared docs stay after Stop Sharing? | Retained. Stop Sharing is not delete. | Decided for Gate 3; pricing/storage quota still needed before paid billing. |
| Where does Delete Cloud Copy live? | Document Settings/Danger Zone with explicit confirmation. | Implementation. |
| Where does Clear Local MarkLab Data live? | App Settings under Privacy/Support/Reset. | Implementation. |
| Is Fly volume snapshot enough? | No. Treat as recovery support only. | More than 10 users. |
| Version retention | Keep all during pilot. | Paid launch / storage pricing. |
| Version History UI | Implemented in the native Sharing & Versions inspector for shared documents. | Browser version controls can wait until later. |
| Browser/native local cache retention | User-controlled plus current limited app cleanup. | Public support docs. |
| Logs | Do not log raw tokens/content/local paths by policy. | Before paid launch, run log audit. |

## Gate 3 Acceptance Checklist

- [x] Storage map created.
- [x] Lifecycle semantics documented for local-only, Start Sharing, active shared documents, revoke link, Stop Sharing, document deletion, workspace deletion, account deletion, and missing local files.
- [x] Retention policy draft created.
- [x] Backup/restore current state and missing drill documented.
- [x] Cleanup jobs needed before launch listed.
- [x] Existing privacy/storage docs checked for overpromise risk and corrected for current Stop Sharing server-grant refresh behavior.
- [x] Product action model decided: Stop Sharing, Delete Cloud Copy, and Clear Local MarkLab Data are separate actions.
- [x] Decide whether the manual pilot can proceed with "hosted content retained until manual cleanup" wording.
- [x] Rename the native toolbar menu from `Collaboration` to `Sharing & Versions` and `Show Collaboration` to `Show Sharing & Versions`.
- [x] Add Stop Sharing hover/help microcopy in the native Collaboration inspector.
- [x] Replace the planned `Cloud Copy & Versions` sheet with inline Sharing/Versions inspector modes after visual review.
- [x] Wire Version History UI to existing list/show/manual-save/restore APIs.
- [x] Implement server-side provider autosave so browser-only shared edits create online checkpoints.
- [x] Document operator-only fallback for Delete Cloud Copy.
- [x] Document support fallback for Clear Local MarkLab Data.
- [x] Add lifecycle/version regression tests for Stop Sharing microcopy, Version History, manual checkpoints, shared-mode `Cmd+S`, and provider-backed autosave. Delete Cloud Copy and Clear Local MarkLab Data remain documented fallbacks until implementation.
- [x] Run and record hosted provider-state version restore smoke.
- [x] Schedule full Neon/Fly infrastructure restore drill before inviting more than 10 users.
- [x] Explicitly defer self-serve cloud document/workspace/account deletion to before public launch.
