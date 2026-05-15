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
