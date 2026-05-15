# Billing Subscription Seats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the commercial control-plane layer for subscriptions, plan limits, workspace member seats, and guest edit quotas.

**Architecture:** Billing state lives in MarkLab's control plane and gates member/session/provider-token issuance. The provider does not know about billing; it only receives authorized short-lived tokens after the control plane enforces plan rules.

**Tech Stack:** PostgreSQL/Neon, Express, Stripe Checkout/Customer Portal or manual alpha subscription records, webhooks, Vitest, control-plane UI.

## Reference Implementations (MIT — OK to copy)

This plan has no relevant prior art in `Learning resources/`. Stripe integration, plan tables, and seat enforcement are entirely MarkLab-original work. The "default to copying" rule still applies — just to Stripe's official samples instead of `Learning resources/`.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** Stripe ships official sample apps for Checkout, webhook signature verification, and Customer Portal. Lift the integration patterns from those samples rather than re-authoring from API docs. Webhook signature verification in particular is a common source of subtle bugs — use Stripe's reference implementation verbatim.
2. **`Learning resources/` is read-only as a directory** at all times — never edit, move, delete, or `git add` anything under it (no Stripe code lives there in v1, but the rule still holds).
3. **Preserve attribution** on copied Stripe sample code — paste the upstream copyright header as a comment block.

---

## Scope

For a private free alpha, this plan can run in manual/free mode while preserving the same tables and enforcement paths. For paid public launch, enable payment provider integration and webhook processing before production launch.

## Provider Runtime Facts From Plan 1B

- Billing and quota checks remain entirely in the control plane before Y-Sweet token issuance. The API-supervised Y-Sweet provider only validates native document tokens; it has no billing or seat-limit knowledge.
- `/healthz` now includes provider schema readiness for `collab_sessions` and `provider_token_issuances`. If this plan adds billing/quota columns used by token issuance, update the health schema contract and add a missing-column `503` regression.

## Control Plane Facts From Plan 2

- Plan 2 already created `plans`, `seat_limits`, and `subscriptions`, seeds `free`, `dev`, `team`, `business`, and `internal`, and creates a `free`/`manual` subscription when a workspace is created.
- Plan 2 already enforces named-member seats through `workspace_share_keys` joins and `seat_limits.member_seats`.
- Plan 2 already enforces concurrent guest edit quota during initial edit-token issuance through `subscriptions` -> `seat_limits.concurrent_guest_edits`. Existing guest edit sessions can refresh without re-running quota after grant/session/role/expiry/revocation checks.
- Documents with `workspace_id is null` still use the legacy fallback guest quota so old/local documents keep working. Billing should not make that fallback path the public hosted default.
- The workspace settings browser shell was created by Plan 3 at `/workspaces/:workspaceId/settings` in `apps/collab-web`. It has Members and Documents tabs wired to the Plan 2 server APIs plus a disabled Plan & Billing placeholder. This plan replaces that placeholder with the real billing view.

## Native Facts From Plan 4

- Native MarkLab.app edit sessions use the same control-plane edit-session and refresh-token path as browser edit sessions, but ask for `clientKind=app`.
- The API only preserves app kind for authenticated native user bearer requests with `X-MarkLab-Native-App: 1` and a non-guest actor. Guest/public-link traffic is downgraded to browser. Billing and audit code must therefore count trusted app sessions from server-derived session metadata, not from client-supplied request bodies.
- Native app sharing creates/imports workspace-owned documents and then creates public edit/view access grants only for collaborators. The first-party embedded app editor is grantless and must not consume guest edit quota.
- Manual/free billing smoke should include a native app edit-session creation or refresh check so app-kind sessions do not bypass plan-table enforcement for collaborator links.

## File Structure

- Modify `apps/api/src/db/schema.sql`
- Create `apps/api/src/services/billing-service.ts`
- Create `apps/api/src/services/seat-limit-service.ts`
- Create `apps/api/src/routes/billing-routes.ts`
- Modify `apps/api/src/routes/workspace-routes.ts`
- Modify `apps/api/src/routes/collab-session-routes.ts`
- Modify `apps/api/src/http/app.ts`
- Add tests beside services/routes.
- Modify the workspace settings UI inside `apps/collab-web/src/workspaces/WorkspaceSettings.tsx` (created in `2026-05-11-collab-web-app.md`; Plan 2 delivered the backing server APIs).
- Modify docs and downstream deploy plan.

## Tasks

### Task 1: Plan And Subscription Model

- [ ] Verify and extend the existing plan records seeded by Plan 2 instead of creating a parallel model.
- [ ] Store Stripe/manual billing metadata on the existing workspace subscription records.
- [ ] Extend named-member seat limits and concurrent guest-edit limits through existing `seat_limits` rows.
- [ ] Add tests proving default workspaces still get the free/manual subscription created by Plan 2.
- [ ] Acceptance: a workspace without an active paid subscription still has deterministic limits.

### Task 2: Seat Enforcement

The enforcement *check points* already exist from `2026-05-11-control-plane-mvp.md` Task 5: that plan added member-seat checks and guest-edit quota checks backed by `subscriptions` and `seat_limits`. This task does **not** add parallel checks. It extracts those lookups into billing/seat-limit services, adds billing-mode metadata, and expands plan coverage.

- [ ] Replace any remaining legacy fallback-only quota assumptions with explicit `subscriptions` -> `seat_limits.concurrent_guest_edits` service calls for workspace-owned documents.
- [ ] Replace any remaining inline member-seat SQL with a shared lookup against `seat_limits.member_seats`.
- [ ] If quota enforcement depends on new columns or tables during provider-token issuance, add them to the `/healthz` schema readiness contract so production cannot go green with an incomplete billing schema.
- [ ] Keep guest view sessions outside guest edit quota (already true; verify with a regression test).
- [ ] Keep first-party native app editor sessions outside guest edit quota while still counting collaborator browser/native guest edit sessions against `seat_limits.concurrent_guest_edits`.
- [ ] Add tests for free-limit pass/fail and paid-limit pass/fail.
- [ ] Acceptance: token issuance refuses over-quota guest edit sessions before calling Y-Sweet, using plan-driven limits for workspace documents. Existing guest edit sessions still refresh when quota is full.

### Task 3: Billing Provider Integration

- [ ] Implement billing adapter with explicit modes:
  - `manual`;
  - `stripe`.
- [ ] In manual mode, admin changes subscription records through an internal route.
- [ ] In Stripe mode, create checkout sessions, process webhook events, and update workspace subscription status.
- [ ] Acceptance: tests cover webhook signature failure, duplicate event id, subscription active, subscription canceled, and payment past due.

### Task 4: Control UI

The workspace settings server APIs exist from `2026-05-11-control-plane-mvp.md` Task 7B. The browser shell now exists in `apps/collab-web/src/workspaces/WorkspaceSettings.tsx` with Members/Documents tabs and a disabled Plan & Billing placeholder. This task replaces that placeholder with the real **Plan & Billing** tab. Do not create a new app.

- [ ] Replace the disabled Plan & Billing placeholder in `/workspaces/:workspaceId/settings` in `apps/collab-web`.
- [ ] Show current plan, member seats used, guest edit sessions used, and upgrade/manage button.
- [ ] Show clear unavailable messages when plan limits block action.
- [ ] Owner-only sensitive actions (upgrade/cancel/manage payment) are enforced server-side; the UI hides them for non-owners but does not rely on UI hiding for security.
- [ ] Acceptance: owner can open the Plan & Billing tab, see usage numbers, and trigger upgrade flow; non-owner sees the tab in read-only mode without management buttons.

### Task 5: Audit And Admin

- [ ] Record plan-limit denials with workspace/session context.
- [ ] Add admin read route for current workspace billing state.
- [ ] Avoid storing payment secrets in normal app logs.
- [ ] Acceptance: support can diagnose a denied invite or denied guest edit token from server logs and database records.

### Task 6: Verification

- [ ] Run `npx -y pnpm@10.0.0 test apps/api/src/services/billing-service.test.ts apps/api/src/services/seat-limit-service.test.ts apps/api/src/routes/billing-routes.test.ts`.
- [ ] Run `npx -y pnpm@10.0.0 exec tsc --noEmit -p apps/api/tsconfig.json`.
- [ ] Run billing/manual-mode smoke.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: add billing and seat enforcement"`.

### Task 7: Downstream Plan Refresh

- [ ] Review actual plan ids, env vars, webhook paths, manual mode behavior, and quota enforcement.
- [ ] Update `docs/appdesigndoc.md` if billing or seat-limit product behavior changed.
- [ ] Update `docs/plans/2026-05-11-production-deploy-alpha-launch.md`.
- [ ] Run `rg -n "billing|subscription|seat|guest quota|Stripe|manual mode|webhook" docs/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh deploy plan after billing"`.
