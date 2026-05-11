# Billing Subscription Seats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the commercial control-plane layer for subscriptions, plan limits, workspace member seats, and guest edit quotas.

**Architecture:** Billing state lives in MarkLab's control plane and gates member/session/provider-token issuance. The provider does not know about billing; it only receives authorized short-lived tokens after the control plane enforces plan rules.

**Tech Stack:** PostgreSQL/Neon, Express, Stripe Checkout/Customer Portal or manual alpha subscription records, webhooks, Vitest, control-plane UI.

---

## Scope

For a private free alpha, this plan can run in manual/free mode while preserving the same tables and enforcement paths. For paid public launch, enable payment provider integration and webhook processing before production launch.

## File Structure

- Modify `apps/api/src/db/schema.sql`
- Create `apps/api/src/services/billing-service.ts`
- Create `apps/api/src/services/seat-limit-service.ts`
- Create `apps/api/src/routes/billing-routes.ts`
- Modify `apps/api/src/routes/workspace-routes.ts`
- Modify `apps/api/src/routes/collab-session-routes.ts`
- Modify `apps/api/src/http/app.ts`
- Add tests beside services/routes.
- Modify control-plane UI files from Plan 4.
- Modify docs and downstream deploy plan.

## Tasks

### Task 1: Plan And Subscription Model

- [ ] Seed plan records for free, team, and internal/admin plans.
- [ ] Store subscription status per workspace.
- [ ] Store named-member seat limit and concurrent guest-edit limit.
- [ ] Add tests proving default workspace gets the free plan.
- [ ] Acceptance: a workspace without an active paid subscription still has deterministic limits.

### Task 2: Seat Enforcement

- [ ] Enforce named-member seat limits when inviting or accepting members.
- [ ] Enforce concurrent guest-edit quota when issuing edit provider tokens.
- [ ] Keep guest view sessions outside guest edit quota.
- [ ] Add tests for free-limit pass/fail and paid-limit pass/fail.
- [ ] Acceptance: token issuance refuses over-quota guest edit sessions before calling Y-Sweet.

### Task 3: Billing Provider Integration

- [ ] Implement billing adapter with explicit modes:
  - `manual`;
  - `stripe`.
- [ ] In manual mode, admin changes subscription records through an internal route.
- [ ] In Stripe mode, create checkout sessions, process webhook events, and update workspace subscription status.
- [ ] Acceptance: tests cover webhook signature failure, duplicate event id, subscription active, subscription canceled, and payment past due.

### Task 4: Control UI

- [ ] Add workspace billing/settings UI.
- [ ] Show current plan, member seats used, guest edit sessions used, and upgrade/manage button.
- [ ] Show clear unavailable messages when plan limits block action.
- [ ] Acceptance: owner can see plan limits and non-owner cannot manage billing.

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
- [ ] Update `docs/superpowers/plans/2026-05-11-production-deploy-alpha-launch.md`.
- [ ] Run `rg -n "billing|subscription|seat|guest quota|Stripe|manual mode|webhook" docs/superpowers/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh deploy plan after billing"`.
