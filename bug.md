# Review Bug Log

This file records correctness/security bugs found by Plan 2 review passes before moving on to Plan 3.

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
