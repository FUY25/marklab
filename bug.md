# Review Bug Log

This file records correctness/security bugs found by plan-level review passes.

## Plan 2 Control Plane Review Findings

1. Remote local-mode relay route wiring was dropped when `apps/api/src/index.ts` constructed `createHttpApp`.
   - Impact: hosted local-file relay mode could create a remote relay service but leave `/api/relay/*` without a route service, returning `relay_service_not_configured`.
   - Resolution: split route-facing relay service wiring from in-memory conflict relay wiring and added an index wiring regression test.

2. Admin tokens were accepted from URL query parameters.
   - Impact: `?token=<admin-token>` could authorize document access and mint provider tokens; query strings leak through URLs, logs, and referrers.
   - Resolution: admin tokens are now accepted only from the `Authorization: Bearer ...` header. Query tokens remain document/share/access tokens only. Added access-route and collab-session regression tests.

3. Provider-token refresh did not re-check control-plane session role or session expiry.
   - Impact: a refresh token could remain usable after a session role downgrade, and refresh lifetimes were not bounded by explicit session expiry.
   - Resolution: added `collab_sessions.expires_at`, constrained refresh lookup to active edit-role unexpired sessions, and added role-downgrade/expiry denial tests.

4. Readiness did not require the new `collab_sessions.expires_at` column.
   - Impact: production health could pass against an incompletely migrated DB, then provider-token refresh would fail at runtime.
   - Resolution: added `collab_sessions.expires_at` to the index health schema column gate and covered it with a regression test.

5. The `collab_sessions.expires_at` migration had no backfill.
   - Impact: existing active edit sessions with issued provider tokens would get `NULL` expiry and fail refresh after deploy.
   - Resolution: backfilled active edit session expiry from the latest issued full provider-token issuance TTL.

6. Final provider-token issuance transition did not atomically re-check session role/expiry.
   - Impact: a session could be downgraded or expire after the initial refresh lookup but before the pending issuance was marked issued.
   - Resolution: `providerTokenIssuanceCanIssue`, final mark-issued transition, and denial-reason lookup now require active edit-role unexpired sessions. Added race-denial tests.

## Plan 3 Collab Web Review Findings

1. Remote Yjs updates were added to the local CodeMirror undo stack.
   - Impact: Bob could undo Alice's remote insert, and the binding would write that undo back into `Y.Text` as a new local deletion.
   - Resolution: annotated remote Y.Text-to-CodeMirror dispatches with `Transaction.addToHistory.of(false)` and added an undo regression test.

2. Generated share/access URLs still opened the legacy `apps/web` document route.
   - Impact: real browser collaborator links did not route to the new formal `apps/collab-web` surface.
   - Resolution: added a shared `buildCollabDocumentPath()` route helper and changed access/share link builders to generate `/collab?docId=...&branchId=...&token=...&mode=...` URLs.

3. View mode rendered raw Markdown source instead of a rendered read-only document.
   - Impact: public view links satisfied the no-provider condition but not the rendered browser view contract.
   - Resolution: added a safe React Markdown snapshot renderer for headings, paragraphs, lists, quotes, and fenced code blocks; view mode now renders selectable/copyable document elements without mounting CodeMirror or a provider.

4. Browser E2E failure-path coverage was incomplete.
   - Impact: revoked view links, session-creation denials, and role-downgrade refresh denials could regress without browser coverage.
   - Resolution: expanded Playwright coverage for revoked view sessions, edit creation denials including seat/quota/expiry-style errors, revoked edit refresh, and role-downgrade refresh.

5. Provider-token refresh scheduling could tight-loop when tokens were already inside the refresh margin.
   - Impact: a short TTL, oversized refresh margin, or clock skew could make every successful refresh schedule the next refresh at `0ms`, hammering the control plane.
   - Resolution: `providerTokenRefreshDelayMs` now uses the shared refresh check interval as the lower bound when the computed refresh time is already due, and a regression test covers short-token successful refresh scheduling.

6. Workspace member role edits stayed visible after the server rejected the mutation.
   - Impact: a non-owner could see a failed local role change as if it succeeded after a `403`.
   - Resolution: member role selection is tracked as a draft and cleared on failure, reverting the visible value to the last server-accepted role. Added a failed-update regression test.

7. Edit-shaped browser sessions accepted read-only provider tokens.
   - Impact: a malformed or future read-only edit response could mount an editable CodeMirror/Yjs session and persist unsynced local edits.
   - Resolution: provider-token authorization is now parsed strictly, and edit sessions reject anything other than `full` authorization for both the issued provider token and nested Y-Sweet client token.

8. Remote `Y.Text` updates were applied to CodeMirror as whole-document replacements.
   - Impact: a remote one-character insert before the local cursor remapped the local selection to the start of the document, so the next local keystroke landed in the wrong position under concurrent edits.
   - Resolution: remote sync now applies incremental `Y.TextEvent.delta` changes adapted from Relay's `LiveEditPlugin`, still excluded from undo history. Added a regression test that types after a remote pre-cursor insert.

9. The offline/reconnect browser E2E only injected status labels.
   - Impact: the test could pass while local offline edits never queued or flushed after reconnect.
   - Resolution: the memory provider now toggles transport state on the E2E provider status event, queues local Yjs updates while offline, broadcasts full Yjs state on reconnect, and the Playwright test verifies another tab receives the offline draft only after reconnect.

10. Provider-token refresh could target the wrong edit session after an out-of-order session response.
    - Impact: a stale session created by React StrictMode, route churn, or a slow first request could overwrite the shared active session; the live editor would then refresh the wrong session token and could become unavailable incorrectly.
    - Resolution: the collab session client no longer owns mutable active edit-session state. The editor captures its own `ActiveEditSession` from the session response and passes that explicit session to every refresh. Added a regression test proving refresh uses the caller-provided session even after a later session exists.

11. Transient provider-token refresh failures permanently disabled editing.
    - Impact: a temporary network drop, 5xx, HTML error page, or JSON parse failure during refresh was treated like revocation and disconnected the editor.
    - Resolution: refresh handling now treats explicit control-plane 4xx denials as terminal and retries other failures after the shared refresh-check interval while showing reconnecting state. Added classification and retry-delay regression tests.

12. Tokens already inside the refresh margin waited for the check interval before refreshing.
    - Impact: a browser waking from sleep or receiving a near-expiry token could continue reconnecting with stale credentials instead of refreshing immediately.
    - Resolution: the first due refresh can run immediately; if a successful refresh still returns a token inside the margin, the next cycle falls back to the shared check interval to avoid a tight loop. Successful refreshes also validate and replace the cached Y-Sweet client token on the active provider.

13. Browser E2E still uses the memory provider rather than the real Y-Sweet websocket path.
    - Impact: the fast browser suite does not directly test `/d/:providerDocId/ws/:providerDocId`, websocket proxying, Y-Sweet auth, or native Y-Sweet reconnect semantics.
    - Resolution: consciously deferred as an integration-matrix gap rather than hiding it. Plan 1B's API-root provider smoke covers the real Y-Sweet proxy/storage path today; Plan 3 verification now also runs that smoke, and downstream reconnect/deploy plans explicitly require the browser-real-provider route matrix.

14. Refreshed provider client tokens bypassed Y-Sweet's document-id validation.
    - Impact: a malformed refresh response with a mismatched `clientToken.docId` could be installed directly into the provider and reconnect this editor to the wrong provider document.
    - Resolution: refreshed provider tokens are validated against the active provider doc id, active session id, and full authorization before install; the provider wrapper also rejects mismatched or non-full replacement client tokens.

15. In-flight refresh completion could mutate a destroyed provider after unmount.
    - Impact: a refresh promise resolving after React cleanup could update refs on a closed-over destroyed provider and schedule a new timer that cleanup could no longer clear.
    - Resolution: refresh success and failure continuations now re-check `disposed` and `unavailable` before mutating provider state or scheduling follow-up refresh/retry timers.

16. Terminal refresh denial only called the real Y-Sweet provider's `disconnect()`.
    - Impact: `@y-sweet/client@0.9.1` reconnects from its close handler after `disconnect()`, so a revoked/forbidden edit session could continue syncing with the old still-valid provider token until token expiry.
    - Resolution: terminal unavailable now calls a provider `terminate()` path. The real-provider wrapper clears cached client tokens, disables websocket close/error reconnect handlers, removes connection-status listeners, wakes reconnect sleepers, sets status offline, and destroys the provider so it cannot reconnect after refresh denial.

17. Successful refresh after a transient failure could leave the UI stuck on `Reconnecting`.
    - Impact: if the provider websocket stayed connected while refresh temporarily failed, the retry success path updated credentials but no provider status event fired to restore the visible connection label.
    - Resolution: after a successful refresh, the editor checks the provider status and restores `Connected` when the provider is already connected.

18. Memory-provider terminal shutdown could still report `connected`.
    - Impact: the E2E memory provider set its closed flag before the offline transition, so `status()` could keep returning `connected` after `terminate()`, hiding refresh-recovery state bugs in browser tests.
    - Resolution: terminal shutdown now transitions offline before closing, destroyed memory providers clear their connected state, and a provider unit test pins the offline status after `terminate()`.

19. Normal real-provider cleanup could still trigger Y-Sweet reconnect work.
    - Impact: React unmount called `destroy()` without clearing websocket close handlers first, so `@y-sweet/client@0.9.1` could run its close/reconnect path during route changes or cleanup and throw `provider_terminated` from the guarded reconnect path.
    - Resolution: normal `destroy()` now clears cached tokens, websocket handlers, reconnect sleepers, connection timers, and status before and after delegating to the underlying provider destroy path; a provider unit test pins the cleanup order.

20. Revoked-edit E2E did not prove local edits were denied after refresh denial.
    - Impact: a regression that showed `Unavailable` while leaving CodeMirror writable would pass the browser test despite the plan requiring local edits to be denied after revocation.
    - Resolution: the revoked edit browser test now attempts to type after the unavailable state and asserts the editor content does not change.

21. In-flight Y-Sweet initial connection could still throw after immediate provider shutdown.
    - Impact: `@y-sweet/client@0.9.1` starts an async connect loop in its constructor and constructs the websocket after awaiting the token path. If MarkLab destroyed or terminated the wrapper before that continuation resumed, the guarded websocket constructor could throw `provider_terminated` as an unhandled rejection.
    - Resolution: the wrapper now patches future `connect()` calls to no-op after termination and wraps `attemptToConnect()` so in-flight attempts race against shutdown and exit cleanly without constructing a new socket; a real-dependency provider lifecycle test pins immediate-destroy behavior.

22. CodeMirror unavailable state did not fully deny non-DOM edit paths.
    - Impact: `EditorView.editable.of(false)` blocks the contenteditable DOM surface but not key-command or programmatic dispatch paths, so local editor/Yjs state could still mutate after a revoked provider-token refresh.
    - Resolution: unavailable state now also enables `EditorState.readOnly` and a transaction filter that rejects local document changes unless they are annotated as Yjs sync transactions; the browser revocation test now verifies both keyboard input and direct editor dispatch are blocked.

23. Memory-provider status reporting collapsed transient statuses to stale `connected`.
    - Impact: after an E2E status event such as `error` or `connecting`, the memory provider could still report `connected`, causing refresh-retry recovery logic to force the visible pill back to `Connected` while the simulated transport was still reconnecting.
    - Resolution: the memory provider now tracks the current status independently from its connected boolean and reports transient statuses accurately; unit coverage pins `error` and `connecting` status reads.

24. Non-JSON 4xx provider-token refresh responses were treated as retryable parse errors.
    - Impact: a proxy/auth layer returning an HTML `401`, `403`, `404`, or `429` page caused JSON parsing to throw before `CollabSessionError` creation, so the editor stayed writable and retried instead of becoming unavailable after a terminal denial.
    - Resolution: non-OK responses now fall back to `http_<status>` when the body is empty or non-JSON, preserving 4xx terminal classification; API-client tests cover non-JSON `403` refresh denial.

25. Malformed remote awareness state could crash cursor rendering.
    - Impact: edit-capable peers control their awareness payloads. Invalid cursor relative-position values or non-string user names could throw during Yjs position resolution or React rendering and disable the editor surface for other collaborators.
    - Resolution: awareness user/cursor state is now normalized and malformed relative positions are caught and dropped; unit tests cover malformed cursor payloads and non-string user names.

26. Edit mode preview rendered raw Markdown instead of rendered Markdown.
    - Impact: the right pane was labeled `Live preview` but used a raw `<pre>`, so headings/lists/quotes/code were not rendered and empty documents displayed invented `# Untitled` content.
    - Resolution: edit preview now reuses the Markdown snapshot renderer used by view mode and renders nothing for an empty document; browser E2E asserts a typed Markdown heading appears as a rendered heading in the preview pane.

27. Plan 3 browser E2E only exercised the memory provider, not the real API-root Y-Sweet websocket path.
    - Impact: a broken browser `@y-sweet/client` connection, API websocket proxy, or real token URL could pass all browser tests because the memory harness used BroadcastChannel instead of `/d/<providerDocId>/ws/<providerDocId>`.
    - Resolution: added a real-provider browser smoke that starts the API-supervised Y-Sweet process, proxies actual control-plane session responses into the Vite app, opens two browser tabs, verifies edit convergence, and asserts a websocket to the API-root provider route is opened.

28. `yTextChangeToFullReplace` was dead exported code and would insert instead of replace if reused.
    - Impact: the unused helper returned a CodeMirror change without `to`, making it a footgun for future editor-binding work.
    - Resolution: removed the dead export.

29. The real-provider browser smoke did not prove the websocket went through the API origin.
    - Impact: a browser could connect directly to the raw Y-Sweet child process and still satisfy a path-only assertion, overclaiming API-root websocket proxy coverage.
    - Resolution: the smoke now asserts the observed provider websocket origin matches the API base URL, carries a provider token, and does not use the raw provider origin.

30. Remote awareness identity strings were normalized for type but not size.
    - Impact: an edit-capable peer could publish a multi-megabyte display name and force collaborators to allocate/render it in caret labels and presence indicators on each awareness update.
    - Resolution: remote awareness user ids and names are capped to 80 characters, with unit coverage for oversized names.

31. Real-provider browser harness leaked resources if setup failed after starting Y-Sweet.
    - Impact: provider readiness or API listen failures could leave a Y-Sweet child process and temp store directory behind because cleanup lived only in the test body after harness creation.
    - Resolution: harness setup now wraps app/server creation, provider readiness, and API listen in a cleanup-aware try/catch that stops the provider and removes the temp store before rethrowing.

32. Real-provider browser smoke reserved both provider and API ports with closed probes.
    - Impact: CI could reuse or steal either port before the real server bound, causing nondeterministic provider startup or API listen failures unrelated to product behavior.
    - Resolution: the API server now binds port `0` directly and uses its actual bound port for the Y-Sweet public URL prefix; only the child-process provider port still needs a probe because Y-Sweet 0.9.1 requires a concrete positive port.

33. Real-provider harness still had setup cleanup outside the first failure boundary.
    - Impact: auth generation/config/start failures and `browser.newContext()` failures could leak the temp provider store or detached Y-Sweet process before the test body cleanup ran.
    - Resolution: harness creation now wraps from temp-dir allocation through provider readiness, and the test body uses nullable harness/context handles in `finally` so partial setup is closed.

34. Raw-provider negative assertion only checked the exact `/d/.../ws/...` path.
    - Impact: a raw-provider websocket on another accepted Y-Sweet websocket path could be ignored while the test still claimed no raw provider origin was used.
    - Resolution: the smoke still positively asserts an API-host `/d/.../ws/...` socket with token, and now rejects every observed websocket whose host matches the raw provider host.

35. Top-level malformed awareness state could still crash presence summaries.
    - Impact: remote Yjs awareness values can be `null`, strings, numbers, or other non-record values; the presence-summary path read `state.user` before validating the top-level shape and could throw on each awareness update.
    - Resolution: `summarizeRemoteCursors` now validates each top-level awareness value as a record before reading `user`, and unit coverage includes null/string/number awareness states.

36. Hostile relative-position `tname` values could mutate local Y.Doc state during validation.
    - Impact: `Y.createAbsolutePositionFromRelativePosition` calls `doc.get(tname)` for top-level relative positions. A malicious awareness cursor targeting rotating fake `tname` values could grow every collaborator's local `doc.share` map before MarkLab dropped the cursor as off-document.
    - Resolution: cursor resolution now pre-validates relative-position shape and requires the `tname` to match the existing `Y.Text("contents")` top-level name before calling Yjs; a regression verifies hostile names do not change `doc.share`.

37. Browser editor state used a different Yjs document shape than the server seed/snapshot path.
    - Impact: the browser bound CodeMirror to `Y.Text("contents")`, while provider seeding and snapshots still used Milkdown/ProseMirror Yjs state. Existing documents could open empty in `apps/collab-web`, and browser edits could be invisible to read-only view snapshots.
    - Resolution: Y-Sweet provider seeds are now converted from canonical branch Yjs state into browser `Y.Text("contents")` state, and server snapshots convert browser `contents` state back through the canonical Milkdown serializer. Provider-token tests cover seeded initial content and browser-edit snapshot reads.

38. Offline IndexedDB persistence was orphaned across reloads.
    - Impact: edit sessions kept `sessionId` and `refreshToken` only in memory, while the IndexedDB key included the session id. A tab crash or reload after offline edits created a new session and a new persistence store, leaving unsynced edits behind.
    - Resolution: edit sessions now persist `sessionId`, `refreshToken`, and the latest provider token in browser storage keyed by document, branch, and route token; reload refreshes the stored session before mounting the provider so the same IndexedDB key is reused. Browser E2E covers an offline draft surviving reload without creating another session after the reload point.

39. Read-only view and live preview used an incomplete ad hoc Markdown renderer.
    - Impact: links, emphasis, inline code, ordered lists, tables, task lists, images, and other common Markdown rendered as raw source despite the Plan 3 rendered view/preview contract.
    - Resolution: the ad hoc line parser was replaced with `react-markdown` plus GFM support, with HTML skipped. Read-only view tests cover links, emphasis, inline code, ordered lists, task lists, tables, and script non-execution.

40. Persisted-session refresh denial was bypassed on reload.
    - Impact: a revoked or forbidden persisted edit session could clear local storage and create a fresh edit session, hiding the terminal denial and leaving editing available when the contract says refresh denial stops editing.
    - Resolution: persisted-session terminal refresh denial now clears the persisted session, surfaces the denial, and does not mint a fresh edit session. Browser E2E covers reload after `provider_token_revoked`.

41. Persisted-session refresh tokens were not validated before remounting the editor.
    - Impact: a wrong-doc, wrong-session, downgraded, or read-only provider token returned during reload could mount an editable CodeMirror/provider session before the normal scheduled-refresh validation ran.
    - Resolution: initial persisted refresh now uses the same provider-doc, session-id, client-token-doc, and full-authorization validation as scheduled refresh. Browser E2E covers a wrong-provider-doc refresh response before editor mount.

42. Rendered Markdown could auto-load attacker-controlled remote images.
    - Impact: public view/edit preview Markdown could trigger remote image requests that expose the collab URL, including grant tokens in the query string, through the browser referrer.
    - Resolution: Markdown images render as inert placeholders instead of `<img>` tags, and external Markdown links include `rel="noreferrer noopener"`. Read-only view tests assert no remote image element is created.

43. Persisted edit sessions stored the refresh token and raw Y-Sweet client token together.
    - Impact: one XSS-readable localStorage value contained both the long-lived refresh secret and the current provider write credential, despite the plan requiring the edit-session refresh token to be stored separately from the Y-Sweet `ClientToken`.
    - Resolution: persisted edit sessions now store only route/session metadata, the refresh token, and the non-secret provider doc id needed for the IndexedDB key. The raw Y-Sweet `ClientToken` is never persisted; a unit test checks the serialized payload.

44. Storage quota/security failures could break session startup or refresh.
    - Impact: localStorage writes could throw after a server session was minted, causing the editor to become unavailable or retry refresh without replacing the provider token.
    - Resolution: persisted-session writes and clears now catch storage errors so quota/private-mode failures degrade reload persistence without breaking the active edit session. Unit coverage simulates quota failure on the real payload write.

45. Offline reload required the control plane to be available before loading IndexedDB edits.
    - Impact: if the page reloaded during a control-plane outage, previously persisted offline edits were not loaded or visible, weakening the offline/reconnect contract.
    - Resolution: when a persisted session exists and refresh fails transiently, the editor mounts with the persisted provider doc id/session id, loads the same IndexedDB store, shows `Reconnecting`, and retries refresh without creating a fresh session. Browser E2E covers reload with temporary control-plane refresh failures.

46. Persisted-session storage kept the raw route/share token.
    - Impact: the share token remained in the localStorage key and payload even though refresh uses the edit-session refresh token and should not need the original grant token after join.
    - Resolution: the route token is now reduced to a short non-secret namespace hash for storage lookup and is no longer present in the storage key or payload. Unit coverage asserts the raw share token is absent.

47. Persisted-session reads required localStorage writes to succeed.
    - Impact: quota/private-mode failures could make an already readable persisted session invisible on reload, causing a fresh session and orphaned IndexedDB edits.
    - Resolution: storage reads no longer run the write probe; only writes require writable storage. Unit coverage verifies an existing session still loads when the storage probe would throw.

## Plan 4 Native Integration Review Findings

1. Native share controls used the old local relay path instead of the login-backed control plane.
   - Impact: native-created links could bypass workspace ownership, workspace document lists, member/guest limits, and access-grant semantics required by the control-plane spec.
   - Resolution: added `NativeControlPlaneShareClient` and `NativeHostedShareController`. MarkLab.app now uses hosted control-plane env credentials (`MARKLAB_CONTROL_PLANE_API_URL`, `MARKLAB_PUBLIC_WEB_URL`, `MARKLAB_USER_TOKEN`, `MARKLAB_WORKSPACE_ID`) to import the local Markdown file into a workspace and create document access grants. Local relay endpoints remain CLI/local-daemon compatibility only.

2. The staged native app shell was not yet a real collaboration editor.
   - Impact: the app could show status/buttons but could not open a file into an editor surface, bind editor text to the provider, project changes to disk, ingest watcher changes, refresh provider tokens at runtime, or stop editing after terminal refresh denial.
   - Resolution: added a native Markdown editing window with open/save actions, embedded hosted `/collab` CodeMirror view for edit links, and `NativeCollaborationRuntime` tests for provider-token refresh lifecycle, provider-to-disk projection, disk-to-provider ingestion, and both-sides-changed conflict detection.

3. The native/browser smoke used an in-process TypeScript `Y.Doc` as the native side.
   - Impact: the smoke could pass while MarkLab.app and its native runtime had no working collaboration behavior.
   - Resolution: the native/browser smoke now first runs the Swift native runtime gate (`NativeCollaborationRuntimeTests`) before the Y-Sweet app-kind/browser convergence check, so smoke cannot pass when the native runtime contracts fail.

4. Native daemon registry writes did not enforce private file permissions and did not coordinate with the CLI registry lock.
   - Impact: the local daemon bearer token could be written into `local-daemons.json` with permissions controlled only by process umask, and concurrent app/CLI writes could drop entries.
   - Resolution: native registry writes now use a `.lock` file compatible with the CLI lock path, write through a temporary file, and force `0600` permissions. Tests cover private mode and lock refusal.

5. Native route-segment encoding used `urlPathAllowed`.
   - Impact: document ids, branch ids, or grant ids containing `/` could be emitted as multiple path segments and target the wrong route.
   - Resolution: fixed by adding strict RFC 3986 segment encoding and tests for slash-containing ids.

## Plan 5 Reconnect Conflict Hardening Review Findings

1. Host relay resume could overwrite newer shared state without conflict review.
   - Impact: a restarted host daemon could publish a stale local file over relay state that advanced while the host was offline, because ordinary `host_update` did not carry expected shared revision/hash and host hello did not reconcile remote state before publishing.
   - Resolution: host startup now reconciles relay hello state before starting the publish loop, applies remote-only changes locally, opens a structured reconnect conflict when local and shared both changed, and sends expected shared revision/hash on ordinary host publishes. Regression coverage asserts relay state is not overwritten after host resume.

2. Mirror reconnect after host return created only a generic paused state.
   - Impact: CLI/browser conflict inspection could see a paused message with no conflict id, local/shared/base Markdown, expected shared revision/hash, or resolvable conflict route. It also paused even when only the local side changed.
   - Resolution: relay host-online status now includes current shared revision/hash/state, and mirror reconnect opens a structured conflict package only when both local and shared changed. Local-only mirror edits replay when host authority returns. Regression coverage covers both paths.

3. Native conflict resolution had a check-then-write race.
   - Impact: an external file write between the native conflict refresh check and the local save could be overwritten after the shared editor accepted the resolution.
   - Resolution: native conflict commit now uses a guarded local save that verifies the current on-disk Markdown and file identity immediately before replacing the file; disk races refresh the conflict instead of overwriting. Regression coverage mutates disk during the native ingestion commit hook.

4. Mirror conflict-resolution publish could overwrite newer shared state after its initial verify.
   - Impact: `publishResolvedState()` checked expected shared revision/hash during hello, then sent a replacement proposal without carrying that guard through relay acceptance. A later shared update before host ack could be silently replaced.
   - Resolution: mirror proposals now carry expected shared revision/hash, the relay stores those guards on the pending proposal, forwards them to the host, and rejects stale host acknowledgements back to the proposer without advancing shared state. Regression coverage advances relay state between proposal and host ack.

5. Mirror rejected-proposal reconnect path still produced an unresolvable paused string.
   - Impact: `host_offline` / `host_lease_expired` proposal rejections closed the mirror socket and never produced a conflict id or structured local/shared/base payload for CLI/browser resolution.
   - Resolution: mirror host-offline/lease rejections now mark the mirror disconnected but keep the socket alive so the host-online payload can replay local-only changes or open a structured reconnect conflict. Regression coverage uses a host-lease rejection followed by a shared change.

6. Native guarded save still had a final same-inode write window before rename.
   - Impact: an external writer that wrote the same inode after the final content check but before rename could still be overwritten.
   - Resolution: native guarded save now hard-links the original file before replacement, restores that backup if the original inode changes after the final check, and leaves the conflict open. Regression coverage writes during the final replacement hook and verifies the external write remains on disk.

7. Use-shared conflict resolution skipped active-provider verification when no relay publish was needed.
   - Impact: an active collaborator edit could race with a keep-shared local disk commit and leave the conflict marked resolved against stale shared Markdown.
   - Resolution: use-shared now verifies and closes active provider state before applying/committing the local resolution even when no relay publish is needed. Regression coverage forces active-provider verification to report stale state and confirms disk/conflict remain unchanged.

8. Use-local and manual conflict resolve published to Relay before active-provider application.
   - Impact: if the active provider changed after verification but before application, Relay could advance to a resolution the live provider never accepted, leaving shared state ahead of the local conflict.
   - Resolution: use-local and resolve now apply the prepared resolution to the active provider before publishing to Relay, and failures refresh the conflict without publishing. Regression coverage asserts provider-apply failure leaves Relay unchanged.

9. Ordinary mirror local-change proposals lacked expected shared-state guards.
   - Impact: a mirror replaying local-only edits after reconnect could race with a shared update and overwrite newer shared state through the host acknowledgement path.
   - Resolution: ordinary mirror proposals now include the last accepted shared revision/hash, Relay rejects stale proposals with the current shared state package, and the mirror opens a structured reconnect conflict instead of continuing blind.

10. Malformed conflict-resolution and Relay shared-state bodies needed explicit failure-path coverage.
    - Impact: invalid route bodies could regress to 500s or mutate state before validation without a focused test catching it.
    - Resolution: added route tests proving malformed conflict resolution and host-published shared-state bodies return `400 invalid_request` and leave local/relay state unchanged.

11. Old direct conflict-resolution service APIs remained in local route test doubles.
    - Impact: stale `useSharedConflict`, `useLocalConflict`, and `resolveConflict` stubs obscured that the guarded route-only resolution path is now the supported API.
    - Resolution: removed the stale methods from the local route test double and verified no production call sites use them.

12. Native guarded conflict save still overwrote external atomic replacements.
    - Impact: an external editor that saved by atomic rename after MarkLab's final check could be overwritten by native conflict resolution.
    - Resolution: native guarded save now rechecks file identity and Markdown after the replacement hook and before renaming MarkLab's temp file. Regression coverage uses `FileManager.replaceItemAt`.

13. API guarded conflict save had the same atomic replacement race.
    - Impact: local daemon conflict resolution could overwrite an external atomic save between the final disk check and MarkLab's replace.
    - Resolution: the guarded write helper now has a final pre-replace hook/check path for conflict resolution and verifies/restores the backup after replacement. Regression coverage atomically renames an external replacement during conflict commit.

14. Initial reconnect conflict creation failed raw when the backing file disappeared.
    - Impact: if the local file was deleted between the reconnect decision and conflict package creation, the caller saw a raw `ENOENT` instead of a paused missing-file state.
    - Resolution: initial conflict opening now pauses the document as `host_file_missing` or `mirror_file_missing` and throws `local_file_missing`. Regression coverage removes the backing file before opening a reconnect conflict.

15. Keep-shared was blocked by host-offline verification even when no relay publish was required.
    - Impact: users could be unable to recover by accepting the already-stored shared snapshot during host-offline reconnect, even though no shared-state write was needed.
    - Resolution: `use-shared` now checks the conflict's stored expected state first, prepares/applies the shared snapshot locally, and only treats host-offline as blocking when a relay publish is required. Regression coverage keeps shared locally with an offline mirror.

16. Empty expected shared hashes made conflicts unresolvable through route validation.
    - Impact: relay rooms without a published shared hash could create conflicts with `expectedSharedHash: ""`, but the route schema rejected that guard with `400 invalid_request`.
    - Resolution: conflict resolution routes now allow an empty expected shared hash while still requiring the revision guard. Regression coverage resolves a conflict whose relay room starts with a null shared hash.

48. Protocol-relative Markdown links were treated as internal links.
    - Impact: `[x](//attacker.example/path)` could navigate to a third-party URL without `noreferrer`, leaking the collab URL and query token on click.
    - Resolution: protocol-relative links are treated as external and receive `rel="noreferrer noopener"` plus `_blank`. Renderer tests cover this case.

49. Blocked browser storage could throw before the editor degraded to a normal session path.
    - Impact: sandboxed/private browser contexts can throw on the `window.localStorage` getter or `getItem`, not only on writes. That could break persisted-session reload handling and leave the editor stuck instead of starting a fresh session or showing unavailable state.
    - Resolution: edit-session storage now treats storage getter/read/remove/write failures as unavailable storage, and unit coverage verifies blocked storage does not throw.

50. Root Vitest discovery skipped `.test.tsx` files.
    - Impact: renderer hardening tests for skipped HTML, inert images, external-link referrer protection, GFM tables, and task lists were only covered by the app-local Vitest config, not by root direct Vitest runs.
    - Resolution: the root Vitest include now covers `.test.tsx` under packages, apps, and src. The direct root renderer-test command is part of this fix verification.

51. Provider seed retries could duplicate the whole document.
    - Impact: converting the same canonical branch Markdown through a fresh Y.Doc produced a different Yjs client id each time, so a seed-marker failure followed by retry could append the full initial document again.
    - Resolution: provider `contents` seed updates now use a deterministic seed client id for the provider document, and token-service tests apply retry updates to the same Y.Doc to prove the text is inserted once.

52. Already-seeded provider docs could remain in the old Milkdown Yjs shape.
    - Impact: docs marked seeded before the browser `Y.Text("contents")` contract landed could mint edit tokens without conversion, causing the browser editor to open empty while old provider state still held the document content.
    - Resolution: initial edit sessions for already-seeded provider docs now ask the token service to read current provider state and add a browser `contents` text when missing. Tests cover the route flag and the Milkdown-state migration.

53. Provider-token refresh skipped provider-shape migration.
    - Impact: a browser restoring an existing edit session through the refresh endpoint could receive a fresh token for an old seeded provider doc that still lacked `Y.Text("contents")`, so reload could mount an empty editor even though initial join was fixed.
    - Resolution: refresh token issuance now also requests provider `contents` migration, and route coverage asserts the refresh path passes the migration flag.

54. Changed seed retries could leave stale provider contents.
    - Impact: deterministic seed client ids made identical retries idempotent, but if the branch Markdown changed after a seed-marker failure, the retry update reused the same Yjs clock range and could be ignored, leaving the provider with stale first-attempt contents.
    - Resolution: seed issuance now reads current provider state when supported and sends a replacement update if existing `contents` differs from the retry seed. Token-service coverage verifies changed retries replace stale contents.

55. MarkLab.app still did not join collaboration after hosted sharing.
    - Impact: the app could import a file and create a browser edit link, but the native window remained a local `TextEditor`; browser edits would not update the app or project back to disk.
    - Resolution: `Start Sharing` now creates an edit access grant and loads the hosted `/collab` CodeMirror/Yjs editor in a `WKWebView`. The collab-web editor posts Markdown snapshots through the `marklabNative` bridge, and MarkLab.app projects them to the local file with conflict guards.

56. Provider projection could overwrite external local-file edits.
    - Impact: a provider update arriving after an AI/editor disk write could save provider Markdown over the local file without checking the projection baseline.
    - Resolution: `NativeCollaborationRuntime.applyProviderMarkdown` rereads disk, compares disk/provider values against the last projected baseline, and returns conflict without writing when both sides changed. Swift coverage asserts the disk edit survives.

57. Native reconnect reset the projection baseline to current disk.
    - Impact: after the app restarted, offline disk changes and remote provider changes could be treated as non-conflicting because the in-memory baseline was replaced with current disk.
    - Resolution: added `NativeProjectionBaselineStore` and reconnect coverage proving the baseline survives runtime recreation and surfaces conflict when disk and provider both changed.

58. Native route paths double-encoded escaped document, branch, and grant ids.
    - Impact: slash-containing ids could be sent as `%252F` instead of `%2F`, targeting the wrong control-plane/local route.
    - Resolution: `appendPath` now writes `percentEncodedPath`; Swift tests assert the actual percent-encoded request path for document, branch, and grant ids.

59. Native owner/member edit sessions lacked bearer authentication.
    - Impact: direct logged-in app edit sessions and refreshes would hit the control plane unauthenticated, leaving only guest-token flows functional.
    - Resolution: `NativeCollabSessionClient` accepts an optional bearer token and sends it on create/refresh; tests cover Authorization headers and still assert refresh uses only the session refresh token in the body.

60. Terminal native refresh denial left the active session populated.
    - Impact: callers could keep retrying or editing against stale session state after revocation/expiry/role downgrade denial.
    - Resolution: terminal 4xx refresh denial now clears the active session and session store, and a regression verifies a second refresh attempt fails locally.

61. Disk ingestion used a full provider-text assignment instead of an explicit provider mutation hook.
    - Impact: the runtime abstraction hid the required disk-to-provider mutation boundary and made it easy to bypass origin tagging.
    - Resolution: added `NativeProviderTextAdapter.applyDiskMarkdown(_:replacing:origin:)`; disk ingestion now calls that hook with `marklab.native.disk`, and tests assert the baseline/origin values.

62. Native/browser smoke described a generic disk writer as native projection.
    - Impact: smoke output could imply MarkLab.app projection was gated when only an in-process helper was writing the file.
    - Resolution: the smoke now builds the `MarkLabApp` product, runs the Swift runtime gate, and uses a hosted-native-webview projection helper with the same conflict guard shape as the WKWebView bridge. Smoke output includes `nativeAppBuildGate` and `nativeWebViewProjectionGate`.

63. Share management UI omitted revoke/copy actions and visible share state.
    - Impact: the native app did not expose all required Plan 4 share-management controls even though some daemon helpers existed.
    - Resolution: MarkLab.app now shows the latest browser link, supports copying it, stores the latest grant id, and revokes it through the hosted control-plane access-grant API.

64. WKWebView bridge messages could write the local file from arbitrary content.
    - Impact: a navigated page, injected frame, or wrong-origin document could call `window.webkit.messageHandlers.marklabNative.postMessage` and overwrite the currently opened Markdown file.
    - Resolution: added hosted-webview origin/path helpers, made the coordinator block navigation outside the expected `/collab` origin, require main-frame messages, and validate message origin/path before accepting Markdown snapshots.

65. Embedded native collaboration sessions were still recorded as browser clients.
    - Impact: MarkLab.app loaded a normal browser edit link, so the control plane saw `clientKind: "browser"` instead of `clientKind: "app"` for native UI sessions.
    - Resolution: embedded native URLs append `clientKind=app`, `apps/collab-web` parses that parameter, and the shared session client is constructed with the app client kind for that route.

66. Shared local-file edits were not ingested from disk by the production app.
    - Impact: AI/editor writes to the shared `.md` while MarkLab.app was open would never reach the provider.
    - Resolution: MarkLab.app now polls the opened shared file, detects one-sided disk changes, and sends them into the embedded CodeMirror/Yjs editor through `window.__marklabNativeApplyDiskMarkdown`; concurrent disk/shared divergence opens a conflict.

67. CLI/app boundary was not connected from the production app.
    - Impact: the CLI could start its own daemon, but MarkLab.app did not create a discoverable daemon boundary while the app owned a file.
    - Resolution: after hosted sharing succeeds, MarkLab.app launches `marklab share <file> --json` in the background to create or reuse the local daemon registry entry without opening a browser or stealing focus. `MARKLAB_CLI_COMMAND` can override the command and `MARKLAB_APP_SKIP_LOCAL_DAEMON=1` disables this bridge.

68. Native conflict handling was only a status string.
    - Impact: divergent disk/provider changes left users with no visibility into the local vs shared versions and no resolution action.
    - Resolution: the native app now stores local/shared/baseline conflict state and renders a two-pane conflict surface with `Accept Local` and `Keep Shared` actions.

69. Native projection wrote every editor transaction immediately.
    - Impact: each Yjs/CodeMirror transaction caused a disk write instead of the required debounced projection boundary, increasing race surface.
    - Resolution: MarkLab.app now debounces shared snapshot projection for approximately two seconds, while `Save` flushes any pending shared projection immediately.

70. Native/browser smoke overstated WebView coverage.
    - Impact: the smoke's disk writer was a TypeScript helper and did not exercise WKWebView bridge security or debounce behavior.
    - Resolution: added Swift coverage for hosted-WebView origin/path policy and kept the smoke honest by separately reporting `nativeAppBuildGate`, `nativeRuntimeGate`, and `nativeWebViewProjectionGate`.

71. Disk edits were acknowledged before the WebView applied them to Y.Text.
    - Impact: if the embedded editor was still loading, navigated, unavailable, or missing the JS bridge, MarkLab.app could advance `lastProjectedMarkdown` and drop a local disk edit without ever applying it to the provider.
    - Resolution: pending disk ingestion now carries the expected baseline and waits for the WebView bridge result before updating Swift baseline state. The coordinator retries bridge calls while the editor loads and only acknowledges success after JS returns `ok: true`.

72. Local disk ingestion could overwrite a concurrent remote provider edit.
    - Impact: Swift checked against a stale local text snapshot, then JS replaced the whole provider Y.Text later; a browser edit arriving between those steps could be silently lost.
    - Resolution: `window.__marklabNativeApplyDiskMarkdown(markdown, baseline)` now checks the live Y.Text against the expected baseline at mutation time and returns `provider_changed` instead of writing when both sides changed. Unit coverage verifies the provider edit is preserved.

73. The WebView bridge accepted any same-origin `/collab` document.
    - Impact: a same-origin navigation to a different document/grant could post snapshots into the currently opened local file.
    - Resolution: bridge navigation and message validation now bind to the exact expected `docId`, `branchId`, `token`, `mode`, and `clientKind` query values, not just origin and path. Swift tests reject wrong-document and wrong-token URLs.

74. Native local daemon APIs were added but not connected to the app UI.
    - Impact: versions, restore, daemon context, and conflict status remained test-only and the production app did not show whether the CLI/app boundary was ready.
    - Resolution: after hosted sharing, MarkLab.app starts or reuses `marklab share <file> --json`, reads the local daemon registry, loads `/api/local/app-context`, shows daemon status/version count, and exposes a restore-latest-version action. Native daemon client tests cover versions and restore endpoints.

75. MarkLab.app joined its own document through a public edit grant.
    - Impact: native editing consumed a collaborator access grant, trusted a route token for the app's first-party session, and could confuse billing/access semantics by making the owner app look like a guest link user.
    - Resolution: `NativeControlPlaneShareClient` now emits a grantless first-party app editor URL with `clientKind=app`; public edit/view grants are created only by the explicit create-link actions. The WKWebView injects the native bearer token only for same-origin `/api/` fetches, and Swift tests assert the app URL contains no access token.

76. Revoked or expired embedded sessions could still ingest disk edits.
    - Impact: after the hosted editor became unavailable, `window.__marklabNativeApplyDiskMarkdown` could remain installed and let MarkLab.app advance the disk baseline even though the provider edit was not accepted.
    - Resolution: the collab editor deletes the native disk-ingestion bridge during cleanup and returns `unavailable` while the editor is unavailable. Swift keeps the pending disk ingestion unacknowledged on non-success responses, so it does not advance the projection baseline after revocation/expiry.

77. Native disk ingestion replaced the whole provider text.
    - Impact: a small disk edit could delete and reinsert the full Y.Text content, inflating update size and increasing the chance that collaborators see avoidable cursor/selection churn.
    - Resolution: `applyNativeDiskMarkdownToText` computes a common-prefix/common-suffix middle span and applies only the changed range inside a `marklab.native.disk` transaction. Unit coverage asserts middle-span delete/insert behavior.

78. Exact WKWebView URL checks still accepted malformed same-document URLs.
    - Impact: duplicate query keys or unknown same-origin parameters could bypass the intended exact expected-URL contract and make bridge authorization depend on URL parsing ambiguity.
    - Resolution: `nativeHostedWebViewURLIsAllowed` now rejects unknown and duplicate query keys and requires the actual query dictionary to match the expected app editor URL exactly. Swift coverage rejects extra tokens, extra params, and duplicate `clientKind` values.

79. The native/browser smoke still does not launch a GUI WKWebView.
    - Impact: treating the smoke as full GUI coverage would hide the remaining gap between provider convergence and AppKit/WKWebView automation.
    - Resolution: the smoke output and design doc now describe this as a native app build/runtime plus hosted projection-helper gate. The actual bridge security and disk-ingestion contracts are covered by Swift WKWebView security tests and collab-web native bridge unit tests; full GUI automation remains a packaging/native-rich follow-up rather than a hidden smoke claim.

80. Native conflict resolution actions re-entered the normal conflict guard.
    - Impact: `Keep Shared` could recreate the same disk/provider conflict instead of overwriting the local file, and `Accept Local` could send the old baseline to the bridge so the provider rejected the explicit resolution.
    - Resolution: `Keep Shared` now uses an explicit conflict-resolution projection path that writes the shared side to disk and updates the baseline. `Accept Local` queues the local side against the current shared side as the expected provider baseline, so the bridge replaces Y.Text only if the provider still matches the conflict shown to the user.

81. Empty provider Markdown was treated as an unseeded provider document during native reconnect.
    - Impact: if a remote collaborator deleted all content while the app was offline, reconnect could seed the provider from disk and silently discard the valid empty remote state.
    - Resolution: `NativeCollaborationRuntime.openSharedDocument()` seeds an empty provider only when no persisted baseline exists. With a stored baseline, empty provider text is reconciled like any other remote change and projects to disk when disk still equals the baseline.

82. Public browser links could spoof native app session metadata with `clientKind=app`.
    - Impact: access-link users could make control-plane session/audit rows look like MarkLab.app sessions by editing the URL query parameter.
    - Resolution: the collab-web route only sends `clientKind=app` when the native wrapper sets `window.__marklabNativeApp`, and the API downgrades `app` to `browser` unless the request is a non-guest bearer request carrying `X-MarkLab-Native-App: 1`. Route tests cover both spoofed public links and first-party native bearer requests.

83. Production MarkLab.app kept projection baselines only in memory.
    - Impact: after restart, the production hosted-WKWebView path could lose the baseline required to classify offline disk/provider divergence.
    - Resolution: added `NativeProjectionBaselineRecord` and `FileNativeProjectionBaselineStore`, storing `lastProjectedMarkdown`, `lastProjectedHash`, `lastProviderStateFingerprint`, and `updatedAt` with `0600` permissions. MarkLab.app now loads and updates that store after successful save/projection/ingestion, and Swift tests cover the full tuple plus reconnect behavior.

84. Revoking a collaborator link discarded pending provider-to-disk projection.
    - Impact: if a shared Markdown snapshot arrived from the hosted editor and the user revoked a link before the debounce fired, the provider/editor state could contain text that never reached the local file or baseline.
    - Resolution: revoking a public access grant no longer cancels the projection task or clears pending shared/disk ingestion state. Link revocation now only clears the latest public link/grant UI state; pending projection still flushes through the normal guarded path.

85. Native Swift edit-session requests missed the server-required native-app proof header.
    - Impact: direct native edit-session creation would be downgraded to `clientKind: "browser"` by the API and then rejected by the Swift client.
    - Resolution: `NativeCollabSessionClient` sends `X-MarkLab-Native-App: 1` whenever it sends a bearer token, and Swift tests assert both Authorization and native-app proof headers on create and refresh requests.

86. Accepting a local conflict could hide the conflict and wedge ingestion when the bridge was unavailable.
    - Impact: `Accept Local` cleared the conflict before the hosted editor accepted the local Markdown; if the JS bridge was unavailable, the UI could show only a waiting status and never retry the same revision.
    - Resolution: conflict-resolution ingestion now carries the displayed conflict as failure context, keeps the conflict visible until success, clears it only after `ok: true`, and restores it on bridge failure so the user can retry.

87. Native/browser smoke did not prove the native client kind.
    - Impact: after server-side spoof protection, the smoke could silently run browser/browser convergence while still claiming app/browser convergence.
    - Resolution: the app-kind smoke session now sends an `ml_user_...` bearer plus `X-MarkLab-Native-App: 1`, and `requestEditSession()` asserts the server returns the requested client kind before returning the provider client token.

88. API native-app proof accepted any bearer-looking Authorization header.
    - Impact: a cookie-authenticated browser request with `Authorization: Bearer garbage`, `X-MarkLab-Native-App: 1`, and `clientKind=app` could be recorded as a native app session.
    - Resolution: `requestHasNativeAppProof()` now requires a MarkLab user-session bearer prefix (`ml_user_`) plus the native marker. API tests cover public-link spoofing, first-party native bearer preservation, and junk-bearer-plus-cookie downgrade.

89. Native baseline persistence failures advanced the in-memory baseline.
    - Impact: if the app support baseline write failed after a projection or ingestion, the running app could classify future disk/provider divergence against a baseline that would be lost after restart.
    - Resolution: baseline updates are now throwing operations. The durable `NativeProjectionBaselineStore` write completes before `lastProjectedMarkdown` advances in memory, and runtime coverage verifies a save failure leaves the old baseline active for conflict detection.

90. Stored provider fingerprints used the disk Markdown hash implicitly.
    - Impact: the baseline tuple contained a `lastProviderStateFingerprint` field, but production callers did not pass an explicit provider-side fingerprint.
    - Resolution: `NativeProjectionBaselineRecord` now requires a provider fingerprint argument. The hosted-WKWebView MVP stores an explicit `provider-ytext:sha256:...` fingerprint of the provider Y.Text Markdown snapshot; runtime tests assert this stored value after projection/ingestion.

91. Shared-file disk ingestion relied only on polling.
    - Impact: external local editor or AI writes were not watcher-driven and could wait for the next timer tick.
    - Resolution: MarkLab.app now installs a macOS `DispatchSourceFileSystemObject` watcher for the opened file and calls the same guarded ingestion path on write/extend/attribute/rename/delete events. The existing timer remains as a backup trigger.

92. Native app daemon bootstrap created a hidden local relay edit grant.
    - Impact: `Start Sharing` spawned `marklab share <file> --json`, whose JSON path created a local relay edit link not shown or revocable in the hosted native share UI.
    - Resolution: added `marklab share --json --daemon-only`, which starts or reuses the daemon and returns daemon metadata without creating an access grant. MarkLab.app now uses that mode for the CLI/local daemon boundary.

93. Packaged runtime links omitted the new shared collaboration package.
    - Impact: installed CLI/native runtime could fail to resolve `@marklab/collab-editor` even though repo-mode pnpm worked.
    - Resolution: packaged runtime preparation now copies `packages/collab-editor`, the packed CLI dependency map points at `file:runtime/packages/collab-editor`, and packaged workspace-link creation covers `@marklab/collab-editor`.

94. Hosted native editor did not verify server-preserved app client kind.
    - Impact: if native bearer injection failed and the server downgraded `clientKind=app` to `browser`, the embedded editor could continue as a browser session inside MarkLab.app.
    - Resolution: `CollaborativeMarkdownEditor` now treats app-client downgrade as `invalid_edit_session_client_kind` and does not connect to the provider. App routing tests cover a downgraded native edit response.

95. API guarded conflict resolution still had a final atomic overwrite window.
    - Impact: an external editor could atomically replace the Markdown file after MarkLab's final identity/hash check but before the guarded commit rename, and MarkLab could overwrite that newer file.
    - Resolution: the API guarded writer now moves the expected file aside, validates the moved-aside inode/content, and commits by hard-linking the prepared temp file into the now-empty destination. If any external file appears first, the operation returns conflict instead of overwriting it. Local-file tests cover the external atomic replacement race.

96. Native guarded conflict resolution had the same final overwrite window.
    - Impact: MarkLab.app could overwrite a newer external atomic replacement during `saveIfCurrentMarkdownMatches`, even though earlier checks proved only the pre-window file identity.
    - Resolution: Swift now uses the same move-aside plus exclusive-link guarded commit pattern and rejects external atomic replacements without overwriting them. Swift tests cover the race.

97. Hosted `/shared-state` rejected an empty expected shared hash.
    - Impact: publishing the first shared state for a room with no prior shared hash could fail validation even though the relay service treats the empty hash as the correct initial guard.
    - Resolution: the hosted relay route now accepts an empty `expectedSharedHash`, and route coverage publishes initial shared state with `expectedSharedHash: ""`.

98. Missing host backing files closed the host socket before sending proposal rejection.
    - Impact: browser collaborators could time out or see a generic host-offline failure when the host Markdown file disappeared because the daemon nulled the socket before sending `host_file_missing`.
    - Resolution: the host controller now sends `host_reject` with `host_file_missing` on the active socket before pausing/closing the host. Relay tests verify the collaborator receives the structured reason and the host transitions offline.

99. Conflict resolution left the active provider mutated when relay publish failed.
    - Impact: `use-local` and pasted conflict resolution could update the active provider Y.Doc before relay publish succeeded. If publish then failed, disk and relay stayed unresolved but connected/new provider clients could see an unpublished resolution.
    - Resolution: relay-publish failure now restores the active provider to the conflict's shared Yjs state under an expected-current-hash guard before refreshing the open conflict. Route tests simulate the active provider hash and verify rollback after `host_offline`.

100. Browser pasted conflict resolution allowed accidental empty-document commits.
    - Impact: the resolved Markdown field started empty and the apply button was enabled, so one click could publish an empty document without confirmation.
    - Resolution: browser conflict review now requires non-empty resolved Markdown, shows a resolved preview, and requires typing `APPLY RESOLVED` before the custom resolution can submit.

101. Native pasted conflict resolution allowed accidental empty-document commits.
    - Impact: MarkLab.app queued the default empty resolved buffer when the shared editor was available, making the native custom resolution path more destructive than the explicit local/shared choices.
    - Resolution: native conflict resolution now requires non-empty resolved Markdown plus `APPLY RESOLVED` confirmation before queueing the shared-editor resolution. Swift tests cover the guard and successful confirmed queueing.

102. Postgres relay shared-state acceptance rejected the initial empty hash guard.
     - Impact: the in-memory relay accepted `expectedSharedHash: ""` when a room had no prior shared hash, but the Postgres path compared `last_shared_hash = ''` and rejected `NULL`, breaking first publish acceptance for database-backed relays.
     - Resolution: the Postgres guard now coalesces `last_shared_hash` to the empty string for guarded comparison, and relay service tests cover a null stored hash with an empty expected hash.

103. Guarded conflict rollback could discard the moved-aside original after destination corruption.
     - Impact: if the new destination was corrupted after MarkLab linked the prepared file but before the committed-content verification, rollback saw the destination already existed, deleted the moved-aside original, and left the bad destination on disk.
     - Resolution: API and native guarded writers now restore the moved-aside original over a bad destination for post-commit verification mismatches while still preserving external destinations for pre-link conflicts. Regression tests cover both paths.

104. Host-side reconnect conflict resolution could deadlock after the host marked itself offline.
     - Impact: the host conflict opener closed the relay socket and marked the room offline, so `accept local` and pasted resolution could fail forever with `host_offline`, and `keep shared` could appear resolved while the relay host stayed offline.
     - Resolution: host conflict publishing now reopens the host socket before verifying/publishing, and keep-shared resolution resumes the host relay before committing the local resolution. Relay and route regressions cover both paths.

105. Mirror reconnect conflicts could use the wrong shared-state guard when the relay hash was null.
     - Impact: a room with no stored relay hash compared as the empty hash at verification time, but conflict packages could fall back to the computed shared content hash and make every resolution fail as stale.
     - Resolution: reconnect conflict creation now stores the actual shared content hash separately from the expected relay guard and defaults the expected hash to `""` when the relay reports `null`. Mirror conflict open paths now pass the normalized expected hash explicitly.

106. Conflict review showed raw versions but no diff before destructive choices.
     - Impact: browser and native users could be asked to choose local/shared/resolved without seeing an explicit diff, violating the preview-first conflict UX contract.
     - Resolution: browser conflict review and native conflict panels now render an explicit local/shared diff before the resolution controls. Component and Swift tests cover the diff preview.

107. Conflict packages did not expose the required `lastProjectedMarkdown` and `lastProjectedHash` fields.
     - Impact: clients and agents could inspect a conflict without the baseline required by the spec, especially when optional base fields were null.
     - Resolution: conflict packages now persist and expose `lastProjectedMarkdown` and `lastProjectedHash`; older stored conflicts are normalized on load with base-field fallbacks. Route coverage asserts both fields are returned.

## Plan 5.5 MarkEdit UI Visual Alignment Findings

1. The native shell still used prototype SwiftUI chrome around the editor.
   - Impact: users saw a MarkLab-specific header and full-width status bar instead of a MarkEdit-style document window where the editor owns the main surface and collaboration is additive.
   - Resolution: moved open/save/share/link/collaboration controls into the native window toolbar, changed collaboration details to an inspector, and replaced the bottom status bar with MarkEdit-style floating status pills.

2. A SwiftPM-launched GUI app could run without presenting a document window.
   - Impact: visual/manual smoke could start `MarkLabApp` as a process but leave the user with no editor window, hiding UI regressions.
   - Resolution: added foreground app activation and a launch-file fallback that opens a MarkEdit document window when SwiftUI has not presented one.

3. The local CodeMirror editor could render blank after opening a Markdown file.
   - Impact: the model loaded and status reported the file, but the WebView stayed empty because native text application could run before the bundled editor bridge was ready, and the module script path was unreliable under app `file://` loading.
   - Resolution: the bundled editor now posts an `editor-ready` bridge signal, the native coordinator polls for the bridge before applying pending Markdown, and the local editor HTML uses a classic bundled script.

4. The SwiftUI launch window ignored the MarkEdit `720x480` document frame.
   - Impact: visual smoke opened MarkLab at `1060x772`, so the app no longer matched the original MarkEdit document-window footprint even though secondary document windows used MarkEdit sizing.
   - Resolution: centralized MarkEdit window metrics, applied the frame through the AppKit window layer once the hosting window exists, and covered the metric contract in native UI strategy tests.

5. The local editor content started underneath the native toolbar.
   - Impact: line 1 was hidden behind the toolbar in the live app, making the editor look unlike MarkEdit and making the first line hard to edit.
   - Resolution: adjusted the bundled CodeMirror theme top inset and verified line 1 is visible in a live MarkLab window screenshot against the original MarkEdit screenshot.

6. The MarkLab toolbar displaced MarkEdit's original editing cluster with Open/Save buttons.
   - Impact: the first-viewport native UI looked like a generic prototype editor rather than original MarkEdit with collaboration added on top.
   - Resolution: restored the MarkEdit-style table-of-contents, heading, bold/italic, and list toolbar cluster, then appended the collaboration controls to the right as the additive layer.

7. MarkEdit syntax styling regressed while trying to copy the original theme.
   - Impact: an attempted highlighter used MarkEdit-only custom tag names that do not exist in the smaller local editor bundle, causing the live WebView to render blank.
   - Resolution: kept the MarkEdit spacing and color CSS, and reintroduced syntax highlighting only with standard CodeMirror tags for heading, quote, strong, emphasis, link, and URL styling.

8. Removing prototype toolbar buttons also removed visible Open/Save access.
   - Impact: matching MarkEdit's toolbar shape by deleting Open/Save buttons would have made local file open/save commands harder to discover and could strand local edits without a native Save command.
   - Resolution: moved Open and Save to the native File menu with Command-O and Command-S shortcuts, preserving MarkEdit-like toolbar chrome without dropping file commands.

9. The restored MarkEdit formatting toolbar initially used disabled placeholder controls.
   - Impact: the UI looked closer to MarkEdit but violated the contract because headings, bold/italic, list commands, and table-of-contents navigation did not actually affect the editor.
   - Resolution: added a native-to-CodeMirror editor command bridge for heading, bold, italic, list, task-list, and goto-line actions; toolbar controls now dispatch real commands for the local editor.

10. Operational status feedback was hidden by the line/column-only status pill.
    - Impact: open/save/share/link/revoke/conflict failures still updated `model.statusText`, but users could no longer see those messages after the full-width status bar was removed.
    - Resolution: kept the MarkEdit-style line/column pill at bottom right and added a second floating operational status pill only for non-routine status messages.

11. MarkEdit default sizing was applied as a forced resize instead of a restorable initial frame.
    - Impact: document windows could be reopened at `720x480` even after the user resized them, and the autosave name was ineffective.
    - Resolution: initial sizing now restores the autosaved `MarkEditDocument` frame first, falls back to the MarkEdit `720x480` default only when no saved frame exists, and saves frames on resize.

12. Launch-file handling had two independent open paths.
    - Impact: a command-line file could be loaded by the normal SwiftUI window and then opened again by the delayed AppDelegate fallback.
    - Resolution: added a launch-file claim coordinator so the SwiftUI path and fallback share one consumption gate.

13. Restored formatting controls inserted Markdown instead of toggling it like MarkEdit.
    - Impact: Bold/italic could nest markers, heading/list controls could only force a style, and todo commands did not follow MarkEdit's unchecked -> checked -> plain cycle.
    - Resolution: changed the local editor command bridge to toggle surrounding inline marks, heading levels, unordered lists, ordered lists, and todo list state in the same behavioral shape as MarkEdit's command tests.

14. The Heading toolbar menu exposed only levels 1 through 3.
    - Impact: half of MarkEdit's heading command surface was missing even though the bridge accepted levels through 6.
    - Resolution: expanded the Heading menu to levels 1 through 6.

15. The normal SwiftUI launch path kept the window title as `MarkLab`.
    - Impact: launch behavior depended on which open path won; fallback windows showed the file name, while normal SwiftUI windows did not identify the opened document.
    - Resolution: the document shell now applies the loaded file URL and filename to the hosting `NSWindow`.

16. Launch fallback still depended on visible window count.
    - Impact: an empty titled SwiftUI shell could suppress the fallback even when the launch file had not been consumed.
    - Resolution: fallback now checks the shared launch-file claim state and opens the file if no path has consumed it.

17. Table of contents parsing treated indented code as headings and missed Setext/CR-only headings.
    - Impact: the restored ToC control could navigate to fake headings or miss headings MarkEdit recognizes.
    - Resolution: ToC extraction now handles ATX and Setext headings, normalizes CRLF/LF/CR, and skips tab/4-space-indented code and fenced code blocks.

18. Shared-mode native UI still replaced the MarkEdit editor surface with the hosted collaboration WebView.
    - Impact: after sharing, MarkLab stopped looking and behaving like MarkEdit because the local editor disappeared and the hosted browser editor became the primary surface.
    - Resolution: shared mode now presents the Y.Text-bound hosted editor visibly inside the MarkEdit-derived native document shell, with native-shell styling that removes browser top chrome/preview and keeps the collaboration engine, remote cursors, and disk-ingestion bridge on the user-facing editor surface.

19. Empty-caret bold and italic commands inserted duplicate markers inside existing marks.
    - Impact: pressing Bold or Italic in already-bold/already-italic text could create nested Markdown markers instead of toggling the active style off like MarkEdit.
    - Resolution: the local editor command bridge now searches surrounding standalone markers at the caret and removes the active pair before falling back to marker insertion.

20. Heading removal dropped indentation.
    - Impact: toggling a heading command off on an indented heading stripped the line indentation along with the heading marker.
    - Resolution: heading removal now preserves the leading indentation capture while removing only the heading marker and following space.

21. Fenced-code parsing did not respect indented code precedence or long fence lengths.
    - Impact: an indented code line beginning with backticks could incorrectly toggle fenced-code state, and a three-backtick close could terminate a four-backtick fence too early.
    - Resolution: ToC extraction now skips tab/four-space indented code before fence handling and tracks fence marker plus opening length so only a matching marker of equal or greater length closes the fence.

22. Nested list toolbar toggles dropped indentation.
    - Impact: turning an indented list item back into plain text through the restored toolbar could flatten nested Markdown structure.
    - Resolution: list parsing now tracks indentation separately from the list marker, preserves it when removing markers, and reuses it when applying unordered, ordered, or task-list markers.

23. Hidden shared-editor bridge lost visible Y.Text binding and remote cursor decorations.
    - Impact: the app preserved a MarkEdit-looking local mirror, but the only real collaborative CodeMirror/Y.Text binding and remote cursor extension lived in an invisible WKWebView.
    - Resolution: the first-party app editor URL now requests `nativeShell=markedit`; collab-web renders a single MarkEdit-styled source editor without browser topbar/preview, and MarkLab.app displays that WKWebView as the shared document editor inside the native toolbar/status/inspector shell.

24. Native text replacement reset the local editor caret to the top of the file.
    - Impact: any programmatic Markdown replacement could move the caret to byte 0 and make the next keystroke land at the beginning of the file.
    - Resolution: the local editor now maps the current selection through whole-document replacements using common-prefix/common-suffix offsets instead of unconditionally moving the cursor to the start.

25. Shared-mode local editor changes bypassed the existing debounced provider-to-disk projection path.
    - Impact: every native keystroke could save to disk and apply into the hidden provider bridge immediately, rather than using the shared editor's Y.Text binding plus the existing approximately two-second native projection debounce.
    - Resolution: removed the hidden-local-editor typing path for shared documents; shared typing now happens in the visible Y.Text-bound hosted editor and reaches disk through `receiveSharedMarkdownSnapshot` / `flushPendingSharedProjection`.

26. Visual comparison against original MarkEdit showed MarkLab-specific toolbar spread.
    - Impact: even after the editor body matched MarkEdit, the native toolbar still looked like a MarkLab control strip because B/I were split into separate buttons and collaboration occupied multiple primary toolbar controls.
    - Resolution: collapsed collaboration into one additive toolbar menu and kept the visible primary toolbar order aligned to MarkEdit's default table-of-contents, heading, bold/italic, and list controls.

27. Native hosted WebView security rejected MarkLab's own MarkEdit shell URL.
    - Impact: the native app generated `/collab` URLs with `nativeShell=markedit`, but the WebView navigation allowlist still rejected that query key, so the shared editor could be cancelled before loading.
    - Resolution: added `nativeShell` to the exact-query allowlist and updated the security regression to accept only the expected `nativeShell=markedit` value.

28. Native conflict state did not make the hosted shared editor read-only.
    - Impact: while the conflict inspector asked the user to review before resolving, direct typing in the visible hosted Y.Text editor could still mutate the conflicted document.
    - Resolution: added a native editability bridge; MarkLab.app sends `isEditable=false` during conflicts, and collab-web blocks local transactions, native disk ingestion, and toolbar commands while still allowing provider/Yjs updates to render.

29. Shared-mode toolbar commands could be dropped while the hosted editor was loading.
    - Impact: the native shell marked a command sequence as applied before the `/collab` page had installed `window.__marklabRunEditorCommand`, so early formatting commands could silently no-op and never retry.
    - Resolution: hosted editor commands now require a `true` bridge acknowledgement before advancing the applied sequence and retry while the bridge is not ready.

30. Native conflict read-only mode also blocked approved conflict resolution.
    - Impact: the hosted shared editor correctly became read-only during conflict review, but native conflict actions also use the hosted bridge to apply the chosen resolution after baseline validation, so conflicts could become unresolvable.
    - Resolution: direct user edits and toolbar commands remain blocked while conflict review is open, but native disk-ingestion/resolution bridge calls are allowed to apply through the baseline-checked Y.Text path.

31. Rehydrated conflict URLs could miss the native MarkEdit shell parameter.
    - Impact: older persisted conflict URLs without `nativeShell=markedit` could reopen inside the native app using the browser editor chrome/preview instead of the MarkEdit-derived shell.
    - Resolution: conflict URL loading and conflict URL persistence now normalize `/collab` URLs to include `nativeShell=markedit` and strip fragments.

## Plan 5.5 Follow-Up Fixes

1. `apps/collab-web` test harness exited 1 on the new native read-only conflict regression because rendering `CollaborativeMarkdownEditor` constructed `IndexeddbPersistence`, and jsdom does not provide `indexedDB`.
   - Resolution: added a file-local `vi.mock('y-indexeddb', ...)` stub in `apps/collab-web/src/App.test.tsx`. The mock satisfies `IndexeddbPersistence`'s constructor and `destroy()` contract without touching browser-side offline persistence, which the App-level routing tests do not assert.

2. `apps/collab-web` vitest jsdom environment shipped a non-functional `window.localStorage` (null-prototype `{}` instead of a `Storage` instance), masked behind the indexedDB unhandled rejection above. Once the indexedDB stop point was fixed, the four `src/api/edit-session-storage.test.ts` cases failed with `localStorage.getItem is not a function`, `localStorage.clear is not a function`, and a null read for a previously-persisted session.
   - Trigger: `vitest@3.2.4` invokes jsdom with `--localstorage-file` but no path (`Warning: --localstorage-file was provided without a valid path`); jsdom then returns a plain empty object on `window.localStorage`. `Storage` and `Storage.prototype` themselves remain intact on `window`, but no real instance is wired in.
   - Resolution: added `apps/collab-web/vitest.setup.ts` and `apps/collab-web/vitest.config.ts`. The setup file installs `Storage.prototype.{getItem,setItem,removeItem,clear,key,length}` backed by a per-instance `WeakMap` (so `vi.spyOn(Storage.prototype, 'setItem')` still works) and replaces `window.localStorage` and `window.sessionStorage` with `Object.create(Storage.prototype)` instances exposed via configurable getters (so `vi.spyOn(window, 'localStorage', 'get')` still works). Coverage: `pnpm --filter @marklab/collab-web test` now reports `Test Files 7 passed (7) | Tests 24 passed (24)` with exit code 0.

   Note: the masking pattern here is the same shape as `bug.md` items 49 (blocked browser storage `get`) and 50 (root vitest discovery skipped `.test.tsx`) — a test-environment defect that hides product-test signal. Whenever a test-harness change opens a new failure, treat it as recovered signal, not new regressions.
