# Gate 8 Public Docs Cleanup Evidence

Date: 2026-05-28

Status: passed for the small controlled pilot.

## Scope

Audited current public/operator docs:

- `README.md`
- `docs/product/*.md`
- `docs/agent/*.md`
- `docs/production/*.md`

Historical docs under `docs/Archive/` and execution plans under `docs/plans/` may retain old terminology when they are clearly archival or planning context.

## Changes

- Updated `README.md` to describe the current hosted control-plane/Y-Sweet native path without a stale deployment date.
- Changed normal app-collaborator instructions from `npx -y @marklab/cli join ...` to the installed MarkLab.app flow. CLI join remains documented only for developer/agent automation.
- Updated version-history wording: native `Sharing & Versions` exposes hosted checkpoints, preview, restore, and Delete Cloud Copy; browser collaborators participate through provider writes/autosave but do not have browser version controls yet.
- Added install/open guidance and known pilot limitations to `docs/product/marklab-alpha-user-guide.md`, including the controlled-pilot Gatekeeper workaround, no public backup/SLA, no paid Stripe flows, no workspace/account hard delete, and deferred `Clear Local MarkLab Data`.
- Updated local-first journey wording for `Sharing & Versions`, Stop Sharing, retained cloud copies, and the separate Delete Cloud Copy action.
- Updated agent docs so broad rewrite checkpoint guidance matches the current native hosted version-history state.
- Moved `docs/production/local-daemon-distribution.md` to `docs/Archive/local-daemon-distribution.md` and linked it from the archive README as historical material.
- Updated the packaging plan's reference to the archived local-daemon distribution doc.

## Stale-Path Scan

Command used:

```sh
rg -n "native relay|relay/native|local daemon|daemon-first|Show Collaboration|@marklab/cli join|npx -y @marklab/cli|/api/local|/api/relay|/relay|/local|host-gated|apps/web|MARKLAB_RELAY|MARKLAB_LOCAL|operator token|owner token|raw token|paid Stripe|Stripe checkout|Clear Local MarkLab Data|hard delete" README.md docs/product docs/agent docs/production -g '*.md'
```

Result after cleanup: no current public instructions route pilot users to old `/relay`, `/local`, host-gated, daemon-first, or `apps/web` paths.

Allowed remaining hits:

- `README.md` says the old local daemon route was removed from active build/test/CLI paths.
- `docs/product/local-url-vs-relay-url.md` includes an explicitly archived localhost URL example and warns not to send localhost URLs to collaborators.
- `docs/production/alpha-launch-runbook.md` says the current alpha does not use the archived local daemon route and documents disabled Stripe/payment flows.
- `docs/production/alpha-launch-runbook.md` mentions owner tokens only for fallback operator bootstrap and explicitly says not to send them to guests.
- `docs/production/relay-ops.md` mentions `MARKLAB_LOCAL_PRODUCTION_SMOKE` only for a local production-like operator smoke, not for pilot setup.
- `docs/product/marklab-alpha-user-guide.md` lists disabled paid Stripe flows, workspace/account hard delete, and `Clear Local MarkLab Data` as known limitations/deferred actions.
- `docs/production/privacy-and-storage.md` describes `Clear Local MarkLab Data` as a future separate device/browser reset action, not a current hosted-delete action.

## Residual Decisions

- Gate 8 does not delete more compatibility code. Active-code simplification remains Gate 9.5 and should wait for pilot support evidence unless a P0/P1 forces it earlier.
- Gate 8 does not create website, video, brand launch copy, billing/pricing copy, signed distribution, or app update pipeline docs. Those remain Gates 10, 10.5, and 11.
- Full Neon PITR/Fly volume restore drill remains deferred to the final launch gate and is not represented as a public SLA.

## Exit Criteria

- New pilot users are directed to installed MarkLab.app, hosted OIDC sign-in for owners/app users, browser guest edit/view links, Start Sharing, Show Sharing & Versions, Stop Sharing, and Delete Cloud Copy semantics.
- Archived daemon/local URL material is marked historical and no longer lives in current production instructions.
- Known limitations are visible in the alpha user guide.
