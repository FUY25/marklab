# Gate 3 Server/Data Lifecycle Audit

Date: 2026-05-22
Baseline branch: `macos-app`
Baseline commit: `3e669de feat: add cloud copy deletion lifecycle`

This audit is for the pre-pilot launch gate. It records what MarkLab stores locally and remotely, what deletion/revocation does today, and what is still missing before a broader launch or paid billing.

## Gate Verdict

Gate 3 passes for the small manual pilot lifecycle scope. The deploy/version path, self-serve `Delete Cloud Copy`, and explicit autosave-version lifecycle policy are implemented, deployed, and verified against the hosted alpha. Treating hosted deletion as an operator-only fallback is no longer acceptable for this gate.

Implemented now:

- The active pilot stack is the hosted control-plane/Y-Sweet path, not the archived daemon/local relay path.
- Shared documents are persisted in Neon Postgres and the Y-Sweet provider store on the Fly volume.
- Native app local bindings, projection baselines, conflicts, and CLI handoff files are written under the user's MarkLab Application Support directory with `0600` file permissions.
- Access grants and share links are revoked by setting `revoked_at`, and provider-token refresh denies revoked/expired grants.
- `Stop Sharing` flushes pending shared projection, revokes currently listed active links when possible, disables native sync for that local file, clears the projection baseline, keeps the retained cloud-copy reference, and returns the native window to local-only editing.
- The native `Sharing & Versions` inspector exposes inline Sharing and Versions modes. Shared documents can list, preview, manually checkpoint, and restore online versions from the app.
- Browser and native edits write the active Y-Sweet provider state. Manual checkpoints and autosave checkpoints read that live provider state, and restore writes the selected version back into the provider before the app/browser continue.
- A server-side provider autosave job periodically creates online version checkpoints for provider-backed branches. Browser-only shared edits are captured even though the browser has no version UI.
- `Delete Cloud Copy` is implemented as a manage-access-only destructive action. It revokes grants, closes sessions, tombstones provider documents for proxy denial/provider cleanup tracking, deletes hosted document/version/current-state rows through cascading document deletion, and keeps the native local Markdown file on disk.
- Autosave retention is implemented for shared online versions: manual/import/create/rollback checkpoints are protected, while old autosave rows outside the latest 30 days of the branch's own edit timeline are pruned without moving branch head/current state.
- Browser edit sessions persist reload metadata in localStorage and Yjs state in IndexedDB under keys scoped by document/provider/session identity.

Missing or not fully implemented:

- No API/UI path exists yet for hard-deleting a workspace or account.
- Scheduled lifecycle cleanup is implemented for stale OIDC states, expired/revoked user sessions, revoked/expired access grants, old access sessions, old provider-token audit rows, old collab sessions, completed native CLI responses, stale browser edit sessions, and provider docs tombstoned by `Delete Cloud Copy`.
- Provider-document deletion records tombstones, denies future provider access through MarkLab's proxy, and the API lifecycle job physically removes tombstoned direct-child Y-Sweet provider directories from the configured local process store such as `/data/ysweet`. It deliberately does not scan or delete unknown provider-store directories.
- Backup/restore guidance exists in the production runbook. Hosted version restore into provider state has been tested on the deployed alpha, and Delete Cloud Copy tombstone/denial behavior has been tested on the deployed alpha. A full Neon/Fly infrastructure restore drill and concrete alpha RPO/RTO have been moved to the final launch gate.
- Public/privacy wording has been corrected for the current Stop Sharing behavior; it should not promise workspace/account deletion until those paths exist.

Pilot recommendation:

- Gate 3 can be marked passed for the small manual pilot. Continue using the deployed alpha for internal/manual verification, but do not invite external pilot users under a promise that workspace/account deletion is self-serve.
- Do not enter paid launch until restore drill evidence and any broader deletion promises are implemented or deliberately scoped into product/legal wording.

Accepted product model:

- `Stop Sharing` stops active sharing/sync for the local file and revokes active links. It does not delete the hosted copy, online version history, provider state, or local Markdown file.
- `Version History` is part of the hosted cloud copy. The backend stores version snapshots and the native app exposes version list/show/manual checkpoint/restore controls for shared documents. Browser collaborators participate in version history through shared provider writes and server-side autosave, but they do not have version controls.
- `Delete Cloud Copy` is a separate destructive document action for deleting the hosted document, online version history, access grants, collaboration sessions, and provider access. It must never delete the local Markdown file.
- `Clear Local MarkLab Data` is a separate device/browser privacy and reset action for removing local MarkLab support data, browser caches, handoff files, local tokens/session metadata, baselines, and conflict copies. It must not delete hosted documents or local Markdown files.
- The product should describe shared documents as local-file-first documents with a hosted cloud copy, not as a purely temporary relay room.

UI placement recommendation:

- Preserve the current native toolbar-menu pattern. The right-side toolbar menu should be renamed from `Collaboration` to `Sharing & Versions`; it should not directly open the inspector.
- In local-only state, the `Sharing & Versions` toolbar menu should primarily show `Start Sharing`.
- In active sharing state, the menu should keep quick actions such as `Stop Sharing`, `Create Edit Link`, and `Create View Link`, plus `Show Sharing & Versions`.
- Keep `Stop Sharing` in the Sharing & Versions inspector because it is the normal per-document sharing state action.
- Add a small hover-only explanation on `Stop Sharing`: "Stops sync and revokes active links. Cloud copy and version history are kept." This keeps the primary UI quiet while making the retention behavior discoverable.
- Put `Version History` inline in the Sharing & Versions inspector so users can compare the current document and prior versions without leaving the editor.
- Keep `Delete Cloud Copy` out of the normal Sharing tab. When implemented, it belongs in a destructive document Danger Zone with explicit confirmation that the local Markdown file stays on disk.
- Put `Clear Local MarkLab Data` in app-level Settings under Privacy/Support/Reset, not in the document Collaboration inspector. It is device/account-local cleanup, not a sharing action for the current document.

Execution plan:

1. Product wording and docs: lock the three-action model in lifecycle, privacy, and user-guide docs.
2. Toolbar/menu IA: the toolbar menu is `Sharing & Versions`, and its active-state inspector item is `Show Sharing & Versions`.
3. `Stop Sharing` UI: add hover/help microcopy and a lightweight confirmation only if the implementation needs one; current behavior should continue retaining the cloud copy.
4. `Version History` UI: completed inline in the Sharing & Versions inspector with list, selected-version preview, manual checkpoint, restore confirmation, and clear copy that restore writes a new rollback version rather than mutating old snapshots.
5. `Delete Cloud Copy` backend: implemented as a manage-access-only document deletion/tombstone API that revokes grants, closes sessions, denies old provider/session access, and preserves the local Markdown file.
6. `Delete Cloud Copy` UI: implemented in the Versions Danger Zone with explicit `DELETE CLOUD COPY` confirmation and success/error states.
7. `Clear Local MarkLab Data` native/browser cleanup: before public launch, add a support/settings action for app support files and browser site data guidance or self-cleanup where technically possible.
8. Version retention and cleanup jobs: autosave-version retention is implemented. Scheduled cleanup now covers expired/revoked grants, sessions, token audit rows, stale native CLI handoff files, stale browser localStorage/IndexedDB entries tied to persisted edit sessions, and provider orphans created by deleted cloud copies.
9. Backup/restore drill: moved to the final launch gate; record Neon and Fly provider restore evidence before broader launch commitments.
10. Tests: Gate 3 evidence proves `Stop Sharing` retention semantics, `Delete Cloud Copy` removes hosted content without touching local disk, autosave retention prunes only eligible autosave rows, and Version History list/show/manual-save/restore keeps working. Before public launch, prove `Clear Local MarkLab Data` removes local traces without touching cloud content.

## Evidence Checked

- Schema and retention fields: `apps/api/src/db/schema.sql`
- Document import/create: `apps/api/src/routes/import-export-routes.ts`, `apps/api/src/services/doc-create.ts`
- Access grants and revocation: `apps/api/src/routes/access-routes.ts`
- Collab sessions and provider-token refresh: `apps/api/src/routes/collab-session-routes.ts`, `apps/api/src/services/provider-doc-service.ts`
- Auth sessions: `apps/api/src/services/user-service.ts`, `packages/shared/src/provider-token-policy.ts`
- Billing usage: `apps/api/src/services/billing-service.ts`
- Lifecycle cleanup: `apps/api/src/services/lifecycle-cleanup-service.ts`
- Native app stores: `apps/marklab-macos/Sources/MarkLabMacOS/NativeAppSupportDirectory.swift`, `NativeSharedDocumentBindingStore.swift`, `NativeCollaborationRuntime.swift`, `NativeConflictStore.swift`, `NativeCLIShareBridge.swift`
- Native Stop Sharing behavior: `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`
- Browser local storage: `apps/collab-web/src/api/edit-session-storage.ts`, `apps/collab-web/src/editor/CollaborativeMarkdownEditor.tsx`, `packages/collab-editor/src/ytext-codemirror.ts`
- Fly provider storage: `fly.toml`
- Production docs: `docs/production/alpha-launch-runbook.md`, `docs/production/privacy-and-storage.md`, `docs/production/relay-ops.md`
- Cleanup search: `rg -n "cron|schedule|setInterval|cleanup|retention|purge|expired|stale" apps/api/src scripts infra .github -g '!**/*.test.ts'`
- Hard-delete search: `rg -n "delete from documents|delete from document_branches|delete from document_branch_states|delete from document_versions|delete from document_access_grants|delete from collab_sessions|delete from provider_token|is_archived = true|set is_archived" apps/api/src -g '!**/*.test.ts'`

## Version Autosave And Retention Policy

Current implementation:

- Local-only native autosave waits 2 seconds after edits and only applies when the file is not sharing.
- Shared documents use server/provider autosave. The API job wakes every 60 seconds only while there are active or recently closed provider connections, considers provider-backed branches after a branch quiet window, and reads the live Y-Sweet provider state.
- The first dirty provider observation is recorded without immediately creating a version. While active editing continues, autosave creates a checkpoint every 10 minutes. After the last edit, if the same provider hash stays stable for 2 minutes, autosave creates a final checkpoint even inside the 10-minute cadence window.
- If the current hash matches the branch head hash, no duplicate version is created.
- Manual `Save Checkpoint`, shared-mode `Cmd+S`, import/create, and rollback versions are separate product checkpoints and are not pruned as autosave noise.
- Autosave retention now prunes only `operation = 'autosave'` rows older than 30 days relative to the latest version timestamp in that branch. This is the page's edit timeline, not the server's current wall-clock date. Branch head/current state is not moved by pruning.

External reference points checked on 2026-05-22:

- Google Docs exposes version history, grouped versions, restore/copy, and named versions. Google says revisions may be merged to save storage space, and named versions prevent merging. Google Docs supports up to 40 named versions per document. Source: https://support.google.com/docs/answer/190843
- Google Drive non-Google file revisions are not a perfect Docs analog, but they show a useful storage-safety pattern: purgeable revisions are typically kept 30 days and can be purged earlier once a file has 100 unpinned revisions. Source: https://support.google.com/drive/answer/2409045 and https://developers.google.com/workspace/drive/api/guides/manage-revisions
- Notion records page versions every 10 minutes while actively editing and records another version 2 minutes after the last edit. Notion retention is plan-based: 7 days Free, 30 days Plus, 90 days Business, and unlimited days Enterprise. Source: https://www.notion.com/help/duplicate-delete-and-restore-content
- Lark/Feishu has explicit manual document version management, independently shareable saved version links, delete/restore for saved versions, and a 30-day restore window for deleted saved versions. Public docs found in this pass did not expose a clear autosave-frequency or version-count retention rule for edit history. Source: https://www.larksuite.com/hc/zh-CN/articles/415325830959-%E5%9C%A8%E6%96%87%E6%A1%A3%E4%B8%AD%E4%BD%BF%E7%94%A8%E7%89%88%E6%9C%AC%E7%AE%A1%E7%90%86%E5%8A%9F%E8%83%BD and https://www.larksuite.com/hc/en-US/articles/622491677103-free-up-personal-storage-space

Recommended MarkLab policy for Gate 3:

- Keep the shared autosave cadence aligned to the Notion-like policy selected for the pilot: active editing checkpoints every 10 minutes, plus a final checkpoint after 2 minutes of stable provider state.
- Protect user-intent versions from automatic pruning: `manual`, `import`, `create`, `rollback`, and future named checkpoints stay until `Delete Cloud Copy` or explicit future version deletion.
- Keep the Gate 3 autosave-only lifecycle simple: retain autosaves within the latest 30 days of the branch's own edit timeline and prune older autosave rows only. Do not use current wall-clock time as the retention anchor.
- Treat `Delete Cloud Copy` as the document-level hard lifecycle boundary: deleting the cloud copy deletes hosted current state, online version history, grants, sessions, and provider state or records provider cleanup as pending. It must never delete the local Markdown file.
- Revisit plan-tier retention in Gate 4 pricing. A plausible paid model is Free/manual pilot 30 days, paid 90 days, and higher-tier/unlimited named/manual checkpoints, but Gate 3 should first make storage bounded and deletion self-serve.

## Storage Map

| Surface | Location | Stored data | Contains raw Markdown/content? | Current retention/deletion behavior | Gap |
| --- | --- | --- | --- | --- | --- |
| User Markdown file | User-selected local disk path | The opened or joined `.md` file | Yes | MarkLab edits the file while open. Cloud revocation and Stop Sharing must not delete it. User/OS controls deletion. | Need public wording to keep saying local file deletion is user-controlled. |
| Native shared binding | `~/Library/Application Support/MarkLab/shared-document-bindings.json` or `MARKLAB_APP_SUPPORT_DIR` override | File path, doc id, branch id, mode, app editor URL, local doc id, baseline hash, sync-enabled flag, optional raw access token | No Markdown, but may include a raw token and local path | Written with `0600`. Stop Sharing keeps the binding with sync disabled so Versions/Delete Cloud Copy still work. Cleared by Delete Cloud Copy or local app data cleanup. | Add "remove all local MarkLab app data" support command later. Avoid storing raw token long-term if not required. |
| Native projection baseline | `~/Library/Application Support/MarkLab/projection-baselines.json` | Last projected Markdown, hash, provider fingerprint, timestamp keyed by local path | Yes | Written with `0600`. Stop Sharing clears only the projection baseline, while keeping the retained cloud-copy binding. Updated during normal sync. | No age cleanup. Contains a local content copy. |
| Native conflict files | `~/Library/Application Support/MarkLab/conflicts/*.json` | Local/shared/base Markdown, hashes, shared fingerprint, editor URL, status | Yes | Written with `0600`. Cleared when conflict is resolved or file-specific conflict is cleared. | No age cleanup for unresolved or abandoned conflicts. |
| Native CLI request/response files | `~/Library/Application Support/MarkLab/cli-requests/*.json`, `cli-responses/*.json` | File path, action, role, join/share link, hosted API/web URLs, bearer token in hosted config, response URL/grant ids/errors | Usually no Markdown, but can include raw bearer token or share link | Written with `0600`. Pending request scan removes stale pending/malformed requests after 600 seconds. Completed responses are pruned after 1 day when the app scans pending requests. | Avoid durable bearer token handoff if possible in a later security/privacy pass. |
| Native session manager | Process memory | Active native shared document list/status | No | In-memory only. Lost when app exits. | No issue for retention, but app support binding is the durable source. |
| Browser localStorage | Browser origin `https://marklab-relay-alpha.fly.dev` | Edit session id, refresh token, provider doc id, route token hash, updatedAt | No Markdown, but includes refresh token | Cleared when terminal refresh/revocation marks editor unavailable. Browser editor startup prunes stale persisted edit sessions after 30 days idle. | "Clear site data" support wording still needed for complete local reset guidance. |
| Browser IndexedDB | Browser origin, y-indexeddb key `marklab:collab-web:<providerDocId>:<sessionId>` | Yjs document cache for reload persistence | Yes, document content in Yjs form | Active component lifecycle destroys the open persistence handle. Browser editor startup deletes the matching IndexedDB database when its persisted edit-session metadata is stale. User can also clear site data. | Site-wide one-click browser cleanup is still a support/settings follow-up. |
| Neon auth tables | `users`, `user_sessions`, `oidc_login_states` | User identity, hashed session tokens, OIDC state verifier, expiry/revocation timestamps | No | User sessions default to 30 days. OIDC states default to 10 minutes. Logout/rebootstrap can mark sessions revoked. Lifecycle cleanup purges used/expired OIDC states older than 1 day and expired/revoked user sessions after the retention window. | No account deletion path found. |
| Neon workspace/billing tables | `workspaces`, `workspace_members`, `workspace_share_keys`, `workspace_folders`, `folder_access_policies`, `plans`, `seat_limits`, `subscriptions` | Workspace ownership/membership, share-key hashes, manual/Stripe billing metadata, seat limits | No | FK cascades clean some child rows if a workspace is deleted directly in DB. App-level workspace deletion path not found. | Account/workspace delete semantics and billing retention need implementation before paid launch. |
| Neon document state | `documents`, `document_branches`, `document_branch_states` | Document/branch metadata, current Markdown, current Yjs state, hashes, provider doc id/seed state | Yes | Created on Start Sharing/import. `Delete Cloud Copy` deletes the hosted document/current-state rows through the manage-access-only API while preserving the local Markdown file. Branches can be flagged `is_archived`, but no separate archive route is active. | Workspace/account hard delete semantics remain deferred. |
| Neon versions | `document_versions` | Saved version Markdown snapshots, hashes, actor ids, operation, version number | Yes | Created on import/create, manual checkpoint, shared autosave, and rollback flows. Manual/import/create/rollback versions are retained; old autosaves are pruned outside the latest 30 days of the branch edit timeline. | Add prune-count observability and plan-tier/named-version rules before pricing if needed. |
| Neon access grants/sessions | `document_access_grants`, `document_access_sessions`, legacy `agent_tokens`, legacy `share_links` | Hashed access tokens, role, expiry/revocation, client presence metadata | No raw Markdown | Revoke sets `revoked_at`. Listing hides revoked grants. Access verification rejects expired/revoked grants. Sessions track last seen. Lifecycle cleanup purges revoked/expired grants and old access sessions after the retention window. | Legacy tables still exist for compatibility but active grants use `document_access_grants`. |
| Neon collab token audit | `collab_sessions`, `provider_token_issuances`, `provider_token_refreshes` | Session ids, refresh token hashes, client kind, actor/grant ids, issuance status, provider errors, expiry/deny reasons | No raw Markdown | Edit provider tokens default to 10 minutes and refresh. Active collab sessions get `expires_at`; refresh denies revoked/expired/forbidden states. Lifecycle cleanup prunes old refresh/issuance rows and then closed/failed/expired sessions after dependents are gone. | Add observability if row volume becomes a cost or audit concern. |
| Fly provider volume | Fly volume `marklab_ysweet_data` mounted at `/data`, store path `/data/ysweet` | Y-Sweet provider document state/checkpoints | Yes, document content in Yjs form | Provider process stores state with checkpoint frequency configured as 10 seconds. Fly app keeps at least one machine running. Rollback does not roll back this volume. Delete Cloud Copy tombstones provider docs and the lifecycle job physically removes only tombstoned direct-child provider directories from the configured local process store after provider token TTL plus 5 minutes. | Snapshot schedule/restore drill not captured in repo. |
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
- It cancels projection, disables the local sync binding, clears the projection baseline for that file, removes the native shared-session entry, and returns the file to local-only editing while keeping a retained cloud-copy reference for Versions/Delete Cloud Copy.
- It does not delete the hosted document, provider state, version history, or local Markdown file.
- Current implementation asks the server for active grants before Stop Sharing. After relaunch, older links may not have copyable URLs because raw tokens are not stored, but revoke works by grant id. If the server list fails, the app falls back to in-memory links from the current app session.

Product decision: `Stop Sharing` should keep this non-destructive behavior. The UI should explain this with hover/help copy instead of making the primary Sharing & Versions inspector heavier.

### Delete Cloud Copy

- Implemented as the destructive cloud-content action, separate from Stop Sharing.
- Deletes the hosted document row so online version history/current state is removed by database cascade.
- Revokes access grants, closes collab sessions, removes provider token rows, and records provider document tombstones so old provider paths are denied through MarkLab's proxy.
- Keeps the local Markdown file on disk and returns the native window to local-only mode after success.
- Lives in the `Sharing & Versions` -> `Versions` Danger Zone with explicit `DELETE CLOUD COPY` confirmation.
- Provider physical cleanup is best-effort and tombstone-driven: the lifecycle job removes known tombstoned provider directories from the configured local process store after the delete path has denied future access. It does not scan unknown provider dirs as generic orphan cleanup.

### Clear Local MarkLab Data

- Not implemented yet as a complete user-facing product action.
- This should remove local MarkLab traces for the device/browser: native app support files, projection baselines, conflict copies, CLI handoff files, local tokens/session metadata, browser localStorage, and browser IndexedDB caches.
- It should not delete hosted documents, online version history, active grants, or the user's Markdown files.
- It should live in app Settings under Privacy/Support/Reset, not in the document Collaboration inspector.
- Current pilot fallback: there is no one-click self-serve reset. Operators can guide the user to Stop Sharing for each shared local file, quit MarkLab, remove MarkLab Application Support data for the relevant profile, and clear browser site data for the hosted origin. This does not delete hosted documents or the user's Markdown files.

### Document deletion

- `Delete Cloud Copy` is the active product path for deleting a hosted document/cloud copy, online version history, access grants, collaboration sessions, and provider access while preserving the user's local Markdown file.
- Native Stop Sharing now keeps a retained cloud-copy reference with sync disabled, so the user can reopen the local file, review online versions, restore a retained snapshot, or run `Delete Cloud Copy` later.
- If an operator directly deletes a `documents` row in Neon, many child rows cascade by schema. This is not the product deletion path and should not be used as pilot guidance.
- Physical provider cleanup is handled by the tombstone-driven lifecycle job for known provider docs. Direct DB deletion does not by itself create the same denial/cleanup trail.

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
| Native shared bindings | Until Delete Cloud Copy or local app data cleanup | Stop Sharing disables sync but keeps the retained cloud-copy reference; Delete Cloud Copy clears the binding | Add all-local-data cleanup/support command. |
| Native baselines/conflicts | Until resolved/Stop Sharing/local cleanup | Conflict resolution clears conflict; Stop Sharing clears baseline | Add stale conflict/baseline cleanup. |
| Native CLI request/response files | Pending requests 600 seconds; completed responses 1 day | Pending scan removes stale pending/malformed requests and completed responses | Reduce durable raw-token handoff exposure later. |
| Browser localStorage edit sessions | 30 days idle, or terminal unavailable state/user clears site data | Terminal refresh/revocation clears current session entry; browser startup prunes stale persisted edit sessions | Add one-click/support UI for complete local reset. |
| Browser IndexedDB Yjs cache | Tied to persisted edit-session metadata; stale sessions pruned after 30 days idle | Browser startup deletes matching IndexedDB DB when removing stale persisted edit session | Does not enumerate unknown DBs without matching session metadata. |
| User sessions | 30 days by default, or revoked by logout/bootstrap rotation | `revoked_at` set on logout/rotation; lifecycle job purges expired/revoked rows after retention | No account deletion path. |
| OIDC login state | 10 minutes active; used/expired states purged after 1 day | Used states marked `used_at`; lifecycle job purges old used/expired rows | None for manual pilot. |
| Access grants/share links | Until revoked/expired, then retained 90 days for pilot audit | Revoke sets `revoked_at`; lifecycle job purges old revoked/expired grants and sessions | Revisit audit retention before public/privacy terms. |
| Access sessions/collab sessions | Retained 90 days after inactivity/closure/expiry | Lifecycle job purges old access sessions and old closed/failed/expired collab sessions once token dependents are gone | Add metrics if churn grows. |
| Provider-token issuances/refreshes | Retain 90 days for alpha audit | Status/deny reason updated; lifecycle job prunes old audit rows | Revisit before paid/public launch. |
| Document current state | Retained while cloud document exists | `Delete Cloud Copy` deletes hosted document/current-state rows | Add workspace/account delete semantics later. |
| Versions | Manual/import/create/rollback retained; autosaves retained within latest 30 days of branch edit timeline | Autosave pruning deletes only old `operation = 'autosave'` rows | Add future plan-tier/named-version policy if pricing needs it. |
| Provider Y-Sweet docs | Provider access denied after Delete Cloud Copy through tombstones; physical local-store cleanup follows after provider token TTL plus 5 minutes | Lifecycle job deletes tombstoned direct-child provider directories from the configured process store and marks cleanup status/error | Does not delete unknown/orphan dirs without a MarkLab tombstone. |
| Billing metadata | Retained in Neon | Manual mode currently | Stripe/legal retention must be defined before paid launch. |
| Logs | Operational retention controlled by Fly/local tools | No repo-controlled cleanup | Audit logs for token/path/content leakage. |

## Deletion Semantics

For manual pilot, use these semantics in user-facing and operator language:

- Revoke link: disables that grant for future joins/refreshes. It does not delete content.
- Stop Sharing: stops this native file's active sharing/sync state and revokes currently manageable active links. It keeps the hosted copy and online version history.
- Delete local file: deletes only the user's local disk file. It does not delete hosted document/provider/version state.
- Delete Cloud Copy: deletes hosted document/provider-access/version state while preserving the local Markdown file.
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
- On 2026-05-22, deployed Fly alpha release `v13` at commit `3e669dec2479ec710ef6bef4a6a03e536bc32558`, image `deployment-01KS7MG85ZKBRRHHFA3EWQKMQZ`.
- Hosted delete/version lifecycle smoke created disposable doc `dfa636d1-937f-4c56-b9c1-701962349328`, wrote through a real Y-Sweet provider session, confirmed export read the provider marker, manual-saved version 2, restored the initial version as rollback version 3, deleted the cloud copy, and confirmed old grant access `403`, old provider-token refresh `404`, provider proxy tombstone `410`, and versions route denial `403`.
- `/healthz` after deploy returned `ok: true` with database, schema, provider, and provider store ready.

What is deferred to the final launch gate:

- Exact Neon backup tier, PITR window, and restore command are not captured in repo.
- Exact Fly volume snapshot schedule and restore procedure are not captured in repo.
- No full Neon PITR/Fly volume restore drill result is recorded for this gate.
- No final alpha RPO/RTO is approved beyond the manual-pilot posture: hosted version restore is verified; infrastructure restore must be treated as manual recovery until tested.

Final launch gate restore-drill checklist:

- Record current Neon backup/PITR capability for `DATABASE_URL`.
- Record current Fly volume snapshot/fork capability for `marklab_ysweet_data`.
- Run a full infrastructure restore drill on a disposable doc:
  - create shared document;
  - write marker from app/browser;
  - confirm marker in Neon snapshot/export and provider state;
  - restore to a staging clone or disposable provider volume;
  - confirm browser/app can read expected restored marker.
- Set alpha RPO/RTO target. Suggested pilot default: RPO 24 hours, RTO 1 business day, with explicit "manual recovery" wording.

## Cleanup Jobs

The key lifecycle cleanup jobs are implemented for the manual pilot. Workspace/account hard delete remains deliberately deferred.

| Status | Cleanup job | Current pilot policy | Reason |
| --- | --- | --- | --- |
| Implemented | Expired OIDC states | Delete used/expired states older than 1 day | Reduces auth table noise and verifier retention. |
| Implemented | Expired/revoked user sessions | Delete revoked/expired sessions after the retention window | Keeps auth table bounded. |
| Implemented | Revoked/expired access grants | Retain metadata for 90 days, then purge token hashes and sessions | Keeps audit short while limiting token-hash retention. |
| Implemented | Expired collab sessions and provider token rows | Retain issuance/refresh audit for 90 days | Bounds high-churn collaboration rows. |
| Implemented | Native CLI completed responses | Delete completed responses older than 1 day during request-store scans | Reduces raw link/token exposure on local disk. |
| Implemented | Browser localStorage/IndexedDB stale entries | Clear persisted edit sessions and matching IndexedDB DBs after 30 days idle | Reduces content copies in browser profile. |
| Deferred | Native unresolved conflicts/baselines | Surface and optionally delete stale unresolved local support copies after user confirmation | Avoids hidden local content copies but needs user-facing judgment. |
| Implemented | Provider docs tombstoned by Delete Cloud Copy | Delete tombstoned direct-child provider store directories after a short grace window; mark cleanup status/error | Removes known provider-store orphans without scanning unknown dirs. |
| Implemented | Old autosave version snapshots | Protect manual/import/create/rollback versions; prune autosave snapshots outside the latest 30 days of the branch edit timeline | Add observability around prune counts before broad launch. |

## Open Decisions For Gate 3 Exit

| Decision | Default for manual pilot | Must be decided before |
| --- | --- | --- |
| Do we promise cloud document deletion? | Yes for user-created cloud copies: `Delete Cloud Copy` must be self-serve before Gate 3 passes. | Gate 3 exit. |
| Do we promise account deletion? | No self-serve promise. Handle manually if needed. | Public launch / privacy terms. |
| How long do shared docs stay after Stop Sharing? | Retained. Stop Sharing is not delete. | Decided for Gate 3; pricing/storage quota still needed before paid billing. |
| Where does Delete Cloud Copy live? | Sharing & Versions -> Versions -> Danger Zone with explicit confirmation. | Gate 3 implementation. |
| Where does Clear Local MarkLab Data live? | App Settings under Privacy/Support/Reset. | Implementation. |
| Is Fly volume snapshot enough? | No. Treat as recovery support only until the final launch-gate restore drill passes. | Final launch gate. |
| Version retention | Shared autosave every 10 minutes during active editing plus a final checkpoint after 2 minutes of stable provider state; keep manual/import/create/rollback versions; prune autosaves outside the latest 30 days of the branch edit timeline. | Gate 3 exit. |
| Version History UI | Implemented in the native Sharing & Versions inspector for shared documents. | Browser version controls can wait until later. |
| Browser/native local cache retention | Browser stale edit sessions and native completed CLI responses are now pruned; full Clear Local MarkLab Data remains a later settings/support action. | Public support docs. |
| Logs | Do not log raw tokens/content/local paths by policy. | Before paid launch, run log audit. |

## Gate 3 Acceptance Checklist

- [x] Storage map created.
- [x] Lifecycle semantics documented for local-only, Start Sharing, active shared documents, revoke link, Stop Sharing, document deletion, workspace deletion, account deletion, and missing local files.
- [x] Retention policy draft created.
- [x] Backup/restore current state and missing drill documented.
- [x] Cleanup jobs needed before launch listed; core scheduled lifecycle cleanup implemented for Gate 3 except workspace/account hard delete and user-judgment local reset flows.
- [x] Existing privacy/storage docs checked for overpromise risk and corrected for current Stop Sharing server-grant refresh behavior.
- [x] Product action model decided: Stop Sharing, Delete Cloud Copy, and Clear Local MarkLab Data are separate actions.
- [x] Decide manual-pilot deletion wording: Stop Sharing retains hosted content; Delete Cloud Copy is the self-serve hosted deletion action.
- [x] Native toolbar/menu now uses `Sharing & Versions` and `Show Sharing & Versions`.
- [x] Add Stop Sharing hover/help microcopy in the native Sharing & Versions inspector.
- [x] Replace the planned `Cloud Copy & Versions` sheet with inline Sharing/Versions inspector modes after visual review.
- [x] Wire Version History UI to existing list/show/manual-save/restore APIs.
- [x] Implement server-side provider autosave so browser-only shared edits create online checkpoints.
- [x] Retract operator-only fallback for Delete Cloud Copy as sufficient Gate 3 behavior.
- [x] Document support fallback for Clear Local MarkLab Data.
- [x] Add lifecycle/version regression tests for Stop Sharing microcopy, Version History, manual checkpoints, shared-mode `Cmd+S`, provider-backed autosave, Delete Cloud Copy, and autosave retention.
- [x] Run and record hosted provider-state version restore smoke.
- [x] Move full Neon/Fly infrastructure restore drill to the final launch gate.
- [x] Implement self-serve `Delete Cloud Copy` before Gate 3 passes.
- [x] Implement autosave-version retention before Gate 3 passes.
- [x] Re-run hosted delete/version lifecycle smoke after `Delete Cloud Copy` and retention land.
