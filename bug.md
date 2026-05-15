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
