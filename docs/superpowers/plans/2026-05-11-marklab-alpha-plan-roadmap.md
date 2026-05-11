# MarkLab Alpha Plan Roadmap

Date: 2026-05-11

Status: Stage-level implementation roadmap. Each plan is intentionally smaller than the full product spec and must produce a testable increment.

## Why This Should Converge

Yes, the proposed structure should make engineering converge, because each stage has:

- A bounded ownership area.
- A working software output.
- A verification gate.
- A final downstream-plan refresh task that forces the remaining plans to absorb what was learned from the actual implementation.

The important rule is that downstream plans are living execution documents, while the spec remains the product/architecture source of truth. A plan can be edited after an upstream implementation changes the facts, but a plan must not silently weaken the spec. If the spec itself changes, update `docs/appdesigndoc.md` in the same stage.

## Current Plan Set

| Order | Plan | Purpose | Blocks |
| --- | --- | --- | --- |
| 1A | `2026-05-11-ysweet-single-file-collaboration-foundation.md` | Baseline reconciliation, provider doc id, token adapter, view snapshot route | All later collaboration work |
| 1B | `2026-05-11-ysweet-provider-runtime-ops.md` | Self-hosted Y-Sweet runtime, persistence, health, Fly shape | Browser app, deploy |
| 2 | `2026-05-11-control-plane-mvp.md` | Login-backed users/workspaces/members/grants/sessions/seat foundation | Browser app, native app, public MVP, billing |
| 3 | `2026-05-11-collab-web-app.md` | Formal browser collaborator entry point | Native app E2E, launch smoke |
| 4 | `2026-05-11-marklab-native-integration.md` | MarkLab.app / MarkEdit-based local editor integration | Packaging, local user workflow |
| 5 | `2026-05-11-reconnect-conflict-hardening.md` | Relay-like conflict UX and reconnect E2E hardening | Alpha release gate |
| 6 | `2026-05-11-packaging-cli-distribution-docs.md` | CLI, packaging, user docs, diagnostics | Deploy readiness |
| 7 | `2026-05-11-billing-subscription-seats.md` | Subscription records, seat enforcement, billing hooks | Paid/public launch |
| 8 | `2026-05-11-production-deploy-alpha-launch.md` | Production deploy, smoke, rollback, launch gate | Alpha launch |

## Sequencing

Recommended execution order:

1. Complete Plan 1A.
2. Complete Plan 1B.
3. Complete Plan 4, the control-plane MVP. This is intentionally before browser/native UI so those clients do not bake in a stub session model that gets replaced later.
4. Complete Plan 2.
5. Complete Plan 3.
6. Complete Plan 5.
7. Complete Plan 6.
8. Complete Plan 7 if public paid launch is in scope for this release; otherwise keep free/manual subscription mode.
9. Complete Plan 8.

Plan 7 can be deferred for a private free alpha, but Plan 4 still must include the data model concepts for seats, subscriptions, and guest quotas because provider-token issuance depends on them.

## Downstream Refresh Rule

Every plan ends with the same convergence gate:

1. Inspect the implementation diff and test results for the current stage.
2. Update `docs/appdesigndoc.md` if the product or architecture decision changed.
3. Update all remaining downstream plan files whose assumptions changed.
4. Run stale-wording scans for provider/token/view/revocation/baseline terms.
5. Commit the plan refresh together with the stage implementation or as the next commit.

This prevents the common failure mode where early implementation facts invalidate later plans and no one notices until deploy.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `gstack plan review` | Scope & sequencing | 1 | FIXED | Moved Control Plane MVP before browser/native work so public identity, grants, token refresh, and revocation are not retrofitted after clients ship. |
| Eng Review | `gstack plan review` | Architecture & tests | 1 | FIXED_WITH_CONCERNS | Added provider-token refresh contract, Y-Sweet runtime source gate, existing schema migration inventory, and deploy build/release path. Remaining concern: Plan 1B must prove the exact upstream Y-Sweet runtime mode before coding. |
| Design Review | `gstack plan review` | UI/UX gaps | 1 | CLEAR_WITH_CONCERNS | Browser/native plans cover cursor/highlight, view mode, unavailable states, and conflict preview. Remaining concern: detailed visual design is still deferred to implementation. |
| Codex Review | `codex review` | Independent 2nd opinion | 0 | NOT_RUN | Not run in this pass. |

**VERDICT:** PROVISIONALLY CLEARED. Start with Plan 1A only. Do not start browser/native implementation until Plan 1B provider runtime and Control Plane MVP contracts pass their gates.
