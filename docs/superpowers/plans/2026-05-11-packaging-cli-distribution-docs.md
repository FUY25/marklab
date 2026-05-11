# Packaging CLI Distribution Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package MarkLab so alpha users and AI agents can install it, share local files, join links, diagnose failures, and follow clear docs without reading source code.

**Architecture:** CLI and native app are the local control surface; hosted provider/control plane are defaults for normal users. The CLI controls software actions and never becomes a hosted content write API.

**Tech Stack:** Existing `apps/cli`, Node packaging, macOS app packaging path selected in Plan 3, docs under `docs/product` and `docs/production`, Vitest/Node tests.

---

## Scope

This plan does not build billing or production deploy. It makes local installation, CLI operation, and user docs reliable enough for alpha smoke testing.

## File Structure

- Modify `apps/cli/marklab.mjs`
- Modify `apps/cli/relay-config.mjs`
- Modify `apps/cli/doctor.mjs`
- Modify `apps/cli/prepare-package.mjs`
- Modify `apps/cli/*.test.mjs`
- Modify native packaging files from Plan 3.
- Modify `README.md`
- Modify `docs/product/marklab-alpha-user-guide.md`
- Modify `docs/production/local-daemon-distribution.md`
- Modify `docs/agent/marklab-agent-guide.md`
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: Hosted Defaults

- [ ] Ensure packaged CLI defaults to hosted alpha API/provider URLs.
- [ ] Ensure local dev can override URLs with env vars.
- [ ] Ensure `marklab doctor` prints which runtime source and URLs are active.
- [ ] Acceptance command: `node apps/cli/marklab.mjs doctor --json` shows hosted/default/local override state.

### Task 2: CLI Command Coverage

- [ ] Confirm or implement:
  - `open`;
  - `share`;
  - `join`;
  - `create-link`;
  - `revoke-link`;
  - `share-state`;
  - `status`;
  - `wait --synced`;
  - `save-version`;
  - `versions`;
  - `conflict`;
  - `doctor`;
  - `stop`.
- [ ] Add tests for hosted-default config and local override config.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 test apps/cli`.

### Task 3: AI Agent Workflow

- [ ] Update `docs/agent/marklab-agent-guide.md`.
- [ ] Document that AI edits local `.md` files directly.
- [ ] Document `wait --synced`, `status`, `conflict`, and `save-version` as the control surface.
- [ ] Add a one-line install/share command for alpha users.
- [ ] Acceptance: an agent can follow the guide without needing provider internals.

### Task 4: Native Packaging

- [ ] Package MarkLab.app using the native packaging path selected in Plan 3.
- [ ] Ensure installed app can start local daemon or discover existing daemon.
- [ ] Ensure normal users do not need Terminal after install.
- [ ] Acceptance: clean install on a test macOS user profile can open, edit, share, and quit.

### Task 5: Distribution Docs

- [ ] Update `README.md` with alpha install path and hosted-default behavior.
- [ ] Update `docs/product/marklab-alpha-user-guide.md` with host and collaborator flows.
- [ ] Update `docs/production/local-daemon-distribution.md` with app/CLI lifecycle.
- [ ] Update troubleshooting for host offline, internal error, token expired, revoked link, conflict required, and sync timeout.
- [ ] Acceptance: docs include exact commands and no stale Plan 04A relay-only instructions.

### Task 6: Package Smoke

- [ ] Run package preparation.
- [ ] Install packaged CLI into a temporary prefix.
- [ ] Run install/share/join/status/wait smoke against local or staging provider.
- [ ] Acceptance: package smoke passes without relying on repo-relative source paths.

### Task 7: Verification

- [ ] Run `npx -y pnpm@10.0.0 test apps/cli`.
- [ ] Run native package smoke.
- [ ] Run docs stale scan: `rg -n "Plan 04A|host-gated|MARKLAB_RELAY_MODE|localhost:3011" README.md docs apps/cli`.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: package marklab alpha cli and docs"`.

### Task 8: Downstream Plan Refresh

- [ ] Review packaged URLs, CLI command behavior, native app lifecycle, and docs.
- [ ] Update `docs/appdesigndoc.md` if packaging reveals a product workflow change.
- [ ] Update these downstream plans:
  - `docs/superpowers/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/superpowers/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "install|share|join|doctor|hosted default|daemon|package|alpha" docs/superpowers/plans docs/appdesigndoc.md README.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after packaging"`.
