# MVP Launch Gap Matrix

This document maps product-launch needs to implementation plans. It is the high-level checklist for deciding whether a gap belongs before MVP launch or after MVP.

## Required Before MVP Launch

| Area | Current gap | Owning plan | Launch gate |
| --- | --- | --- | --- |
| Real browser document mode | Web app can run local harnesses, but needs `/docs/:docId/branches/:branchId` backed by Hocuspocus and deterministic active-doc flush before API boundaries. | `plans/06_3_web_remote_document_mode_plan.md` | Two browser windows open the same backend doc, sync through WebSocket, and API read/write/export see active browser edits. |
| API/agent write visible in browser | API writes are covered in backend tests, but browser route must show API-originated updates without refresh. | `plans/06_3_web_remote_document_mode_plan.md` | Playwright imports a doc, opens it in browsers, calls `write_doc`, and both browsers update. |
| Document lifecycle UI | Create/import/export APIs exist, but users need Web controls. | `plans/06_4_web_document_lifecycle_ui_plan.md` | User can create blank, import `.md`, open existing doc, and export `.md` with server filename. |
| Version and branch UI | Backend version routes exist, but product needs browser history and branching. | `plans/06_5_web_version_branch_ui_plan.md` | User can list versions, preview old Markdown, branch from version, switch branch, and restore as new version. |
| Access control | `agent_tokens` and `share_links` tables exist, but routes, middleware, UI, WebSocket auth, and controlled-MVP admin bootstrap are missing. | `plans/06_6_access_tokens_share_links_plan.md` | Auth-required mode rejects unauthenticated access/create/import; edit links, agent tokens, and admin bootstrap work. |
| CLI and agent skill | API exists, but agent-facing CLI/skill workflow is not complete. | `plans/07_cli_agent_skill_plan.md` | `marklab read-doc/edit-doc/write-doc/import-doc/export-doc/versions` works and skill instructs fresh read before `write_doc`. |
| Deployment hardening | Basic deployment plan lacks web image, schema command, readiness, smoke script, and runbook. | `plans/08_deployment_plan.md`, `plans/08_1_deployment_hardening_plan.md` | Compose or hosted stack serves web/API/WebSocket with `/readyz` and smoke passing. |
| Launch acceptance | Tests exist by layer, but final release gate must tie product workflows together. | `plans/11_mvp_launch_readiness_plan.md` | Automated tests, browser E2E, CLI smoke, deployment smoke, and manual QA pass. |

## Post-MVP Or Explicitly Deferred

| Area | Reason deferred |
| --- | --- |
| Full org/team RBAC | MVP uses document-scoped share links and agent tokens. |
| Billing and subscription management | Not required for technical MVP validation. |
| GitHub sync | Source-of-truth semantics are intentionally deferred. |
| Local bidirectional file sync | Local files are import/export snapshots only. |
| MCP adapter | CLI + agent skill is the MVP agent workflow; MCP can wrap it later. |
| In-app AI diff approval UI | Codex/Claude Code chat and tool permission own review for MVP. |
| AI streaming UX and selection-aware AI | Not required for deterministic document write safety. |
| Image upload/storage | Image insertion remains disabled until storage is designed. |
| Comments/reactions | Not required for first collaborative Markdown/agent loop. |
| Advanced version graph visualization | MVP starts with list-based version and branch UI. |

## Product Launch Readiness Summary

The remaining MVP launch work is not mainly in the live writer anymore. The critical missing product layer is the browser-facing workflow around the now-existing backend capabilities:

```text
real remote document route
  -> document lifecycle UI
  -> version/branch UI
  -> access links and agent tokens
  -> CLI/skill workflow
  -> deployment hardening
  -> final launch acceptance
```
