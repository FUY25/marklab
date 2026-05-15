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
