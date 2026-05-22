# Gate 4 Cost Instrumentation And Unit Economics

Date started: 2026-05-22

Status: Passed for the small free pilot scope. Workspace usage is now measurable from Postgres plus the Fly provider volume, and the current public platform rate-card model is recorded. The model is enough to bound the small free pilot, but it is not enough for paid pricing. Actual Neon CU-hours/history storage, Fly Cost Explorer totals, per-workspace API request volume, egress, and support time still need to be measured before Gate 11 paid billing.

## Operator Commands

Workspace usage report:

```sh
DATABASE_URL=<neon-postgres-url> \
MARKLAB_PROVIDER_STORE_PATH=/data/ysweet \
node scripts/marklab-workspace-usage-report.mjs --since-days 30
```

For the current deployed Fly alpha, the script was copied temporarily into the running machine and executed there so it could use the existing `DATABASE_URL` secret without printing it:

```sh
MARKLAB_PROVIDER_STORE_PATH=/data/ysweet \
node /app/scripts/marklab-workspace-usage-report.mjs --since-days 30
```

This temporary machine copy was removed after the report ran. It was not part of the deployed image and did not change persisted app data.

## Queryable Usage Inventory

| Meter | Source | Workspace-level today? | Gate 4 status |
| --- | --- | --- | --- |
| Active documents | Neon `documents` joined to `workspaces` | Yes | Reported by script. |
| Provider document count | Neon `document_branch_states.provider_doc_id` | Yes | Reported by script. |
| Provider store bytes | Fly volume `/data/ysweet/<providerDocId>` | Yes, by matching provider doc ids to Neon | Reported when `MARKLAB_PROVIDER_STORE_PATH` or JSON byte map is provided. |
| Current Markdown bytes | Neon `document_branch_states.current_markdown` | Yes | Reported by script. |
| Current Yjs state bytes | Neon `document_branch_states.yjs_state` | Yes | Reported by script. |
| Version snapshot bytes | Neon `document_versions.markdown_snapshot` | Yes | Reported by script. |
| Collab session minutes | Neon `collab_sessions.created_at` to `last_seen_at` | Approximate | Reported by script. This is session span, not socket-open wall time. |
| Guest edit sessions | Neon `collab_sessions` | Yes | Reported by script. |
| Provider token refresh count | Neon `provider_token_refreshes` joined through sessions/docs | Yes | Reported by script. |
| Last active time | Max of document, version, access, collab, and token timestamps | Yes | Reported by script. |
| API request count | None in current schema | No | Script reports unavailable. Add request metrics or log-derived aggregation before pricing. |
| Estimated egress | Not available per workspace from current DB/Fly CLI snapshot | No | Script reports unavailable. Add provider/API byte counters or export provider metrics before pricing. |
| Neon database size | `pg_database_size(current_database())` | Whole DB | Reported by script. |
| Neon compute CU-hours/history storage | Neon console/API/billing export | Whole project | Not captured in this pass; required before Gate 4 passes. |
| Fly compute and volume shape | `fly status`, `fly scale show`, `fly volumes list/show`, `fly volumes snapshots list` | Whole app | Resource snapshot captured. Actual Cost Explorer/bill export still required. |

## Production Snapshot

Measured at 2026-05-22 13:00 UTC against `marklab-relay-alpha`.

Hosted health was green:

- `/healthz`: `ok: true`
- database ready: `true`
- schema ready: `true`, missing `[]`
- provider ready/store ready: `true` / `true`

Deployment/resource shape:

- Current deployed Fly release: `v13`, image `deployment-01KS7MG85ZKBRRHHFA3EWQKMQZ`
- Important deployment caveat: this is still the Gate 3 deployed image from commit `3e669dec2479ec710ef6bef4a6a03e536bc32558`; later hardening commit `10aad0d1f270c3dfb8d0b9dc42f445ded03c8936` has not been deployed in this Gate 4 pass.
- Fly machine: `0803d9dc665328`, region `sin`
- Fly scale: 1 app process, shared CPU, 1 CPU, 1024 MB memory, `min_machines_running: 1`
- Fly volume: `vol_4qll6qnklddxy38r`, `marklab_ysweet_data`, 1 GB, encrypted, auto backup enabled, snapshot retention 5
- Fly volume snapshots listed: 4 created snapshots, total logical snapshot bytes 115,924,202 bytes, each with 1 GB `volume_size`

Neon/Postgres snapshot:

- Database: `neondb`
- `pg_database_size(current_database())`: 10,756,096 bytes
- Largest active/current tables by `pg_total_relation_size` included `provider_token_issuances` at 229,376 bytes, `document_branch_states` at 204,800 bytes, `provider_token_refreshes` at 131,072 bytes, `collab_sessions` at 122,880 bytes, `document_versions` at 98,304 bytes, and `document_access_sessions` at 98,304 bytes.
- Legacy relay tables still exist in the deployed database and contribute storage, even though Gate 2.5 removed the old active route/code path. They are inert for the current pilot but still part of current Neon storage until a later explicit drop migration.

Workspace usage report, 30-day window:

| Metric | Current value |
| --- | ---: |
| Workspace count | 1 |
| Active workspace count | 1 |
| Active documents | 15 |
| Provider documents in Neon | 15 |
| Provider directories on `/data/ysweet` | 19 total, 15 matched to the active workspace |
| Current Markdown bytes | 2,222 |
| Current Yjs state bytes | 6,359 |
| Version snapshot bytes | 3,147 |
| Neon retained content bytes | 11,728 |
| Matched provider store bytes | 35,249 |
| Total matched retained content bytes | 46,977 |
| Version count | 29 |
| Autosave versions | 10 |
| Manual-save versions | 1 |
| Access grants | 22 total, 10 active |
| Collab sessions | 84 |
| Guest edit sessions in window | 52 |
| Collab session minutes in window | 1,435.44 |
| Guest edit session minutes in window | 1,114.55 |
| Provider token issuances in window | 299 |
| Provider token refreshes in window | 223 |
| Last active time | 2026-05-22 12:53:48 UTC |

Because there is only one active workspace today, the p50/p90/p99 usage percentiles are identical to that workspace's values. This is not a real distribution yet; the next Gate 4 report should be rerun after at least 3-10 external pilot workspaces have real usage.

## Pricing Inputs

Current public rate references checked on 2026-05-22:

- Fly.io pricing: https://fly.io/docs/about/pricing/
- Neon pricing: https://neon.com/pricing

These public rates are useful assumptions, but they are not a substitute for the actual Fly Cost Explorer and Neon usage/billing snapshots for this account.

Public rate card checked on 2026-05-22:

| Platform | Meter | Public rate used in this model | Source |
| --- | --- | ---: | --- |
| Fly.io | Started `shared-cpu-1x`, 1 GB RAM machine | `$5.92/month` | https://fly.io/docs/about/pricing/ |
| Fly.io | Persistent volume provisioned capacity | `$0.15/GB-month` | https://fly.io/docs/about/pricing/ |
| Fly.io | Volume snapshots | `$0.08/GB-month`, first 10 GB free | https://fly.io/docs/about/pricing/ |
| Fly.io | Asia Pacific public egress | `$0.04/GB` | https://fly.io/docs/about/pricing/ |
| Neon Launch | Compute | `$0.106/CU-hour` | https://neon.com/pricing |
| Neon Launch | Database storage | `$0.35/GB-month` | https://neon.com/pricing |
| Neon Launch | History / instant restore storage | `$0.20/GB-month` | https://neon.com/pricing |
| Neon Launch | Public network transfer | 100 GB included, then `$0.10/GB` | https://neon.com/pricing |
| Stripe Payments | Domestic cards | `2.9% + $0.30` | https://stripe.com/pricing |
| Stripe Billing | Pay-as-you-go subscription billing | `0.7%` of Billing volume | https://stripe.com/pricing |

Pricing model formulas:

```text
fly_monthly = machine + volume + max(snapshot_gb - 10, 0) * 0.08 + fly_public_egress_gb * 0.04
neon_monthly = neon_cu_hours * 0.106 + database_gb * 0.35 + history_gb * 0.20 + max(neon_egress_gb - 100, 0) * 0.10
infra_cost_per_active_workspace = (fly_monthly + neon_monthly) / active_workspace_count
monthly_card_no_loss_price = (workspace_cost + 0.30) / (1 - 0.029)
monthly_card_plus_billing_no_loss_price = (workspace_cost + 0.30) / (1 - 0.029 - 0.007)
```

Current measured lower bound for the whole hosted alpha, before Neon compute CU-hours, egress, support, and payment fees:

| Component | Current measured basis | Lower-bound monthly cost |
| --- | ---: | ---: |
| Fly always-on machine | 1 shared CPU / 1024 MB machine, `min_machines_running: 1` | about `$5.92` if using Fly's current shared-cpu 1 GB public rate |
| Fly volume | 1 GB provisioned volume | about `$0.15` at Fly's current volume public rate |
| Fly snapshots | 115.9 MB listed; Fly public pricing currently includes the first 10 GB snapshot storage | `$0.00` under current free snapshot allowance |
| Neon data storage | 10.76 MB database size | less than `$0.01` at Neon public storage rates |

Known lower-bound fixed infra is therefore about `$6.08/month` for the current whole alpha stack, excluding Neon compute CU-hours, egress, support time, and payment processing. With one active workspace today, that lower bound allocates to about `$6.08/workspace-month`; with 10 active workspaces on the same single-machine stack, the lower-bound fixed allocation would be about `$0.61/workspace-month` before the missing inputs.

This lower-bound number is intentionally not a paid price. Gate 11 must wait until the missing meters are captured and a no-loss floor is calculated from actual bill data.

## Public-Rate Scenario Model

These scenarios use the current one-machine Fly shape, current 10.76 MB Neon database size, Fly Asia Pacific egress pricing, and Neon Launch rates. They are not invoice data.

| Scenario | Whole stack / month | 1 active workspace | 10 active workspaces | 50 active workspaces |
| --- | ---: | ---: | ---: | ---: |
| Neon free/near-zero, 0 GB Fly egress | `$6.08` | `$6.08` | `$0.61` | `$0.12` |
| Low pilot: 10 Neon CU-hours, 10 GB Fly egress | `$7.54` | `$7.54` | `$0.75` | `$0.15` |
| Base pilot: 50 Neon CU-hours, 10 GB Fly egress | `$11.78` | `$11.78` | `$1.18` | `$0.24` |
| Intermittent load: 140 Neon CU-hours, 50 GB Fly egress | `$22.92` | `$22.92` | `$2.29` | `$0.46` |
| Always-warm low load: 187.5 Neon CU-hours, 100 GB Fly egress | `$29.95` | `$29.95` | `$3.00` | `$0.60` |

For the current architecture, storage is not the cost driver:

- Current Neon database storage at 10.76 MB is less than `$0.01/month` on Neon Launch storage/history rates.
- A 25 MB provider-store budget costs about `$0.004/month` on Fly volume storage.
- The real variable risks are Neon compute, Fly egress, machine scaling, and support time.

Future Stripe no-loss floor examples, using the 10-active-workspace scenario:

| Scenario | Infra per active workspace | Domestic card no-loss floor | Domestic card + Stripe Billing floor | International/currency + Billing stress floor |
| --- | ---: | ---: | ---: | ---: |
| Low pilot | `$0.75` | `$1.09` | `$1.09` | `$1.12` |
| Base pilot | `$1.18` | `$1.52` | `$1.53` | `$1.57` |
| Intermittent load | `$2.29` | `$2.67` | `$2.69` | `$2.76` |
| Always-warm low load | `$3.00` | `$3.39` | `$3.42` | `$3.51` |

Support time changes the floor much more than platform storage. If support is valued at `$50/hour`, then 10 minutes per workspace-month adds `$8.33`; in the intermittent-load scenario above, the domestic card + Stripe Billing no-loss floor moves from about `$2.69` to about `$11.33`.

## Pilot Cost Guardrails

These are manual admission/support guardrails for the small external pilot. They are not the final Free plan. Specific free-plan packaging can wait until the billing/pricing gate.

Existing `seat_limits` already define `free` as 1 member seat and 3 concurrent guest edit sessions. Do not use the broad `dev` plan caps for normal external pilot users unless the operator intentionally creates an internal smoke workspace.

| Guardrail | Pilot value | Enforcement status |
| --- | --- | --- |
| Total external pilot workspaces | 10 maximum before a fresh Gate 4 cost review | Manual/operator. |
| Workspace members | 1 owner/member | Enforced if workspace is on `free`; current internal smoke workspace is `dev`. |
| Concurrent guest editors | 3 | Enforced if workspace is on `free`. |
| Active shared documents per real pilot workspace | 5 | Manual/operator for now. Current internal smoke workspace exceeds this because it contains disposable lifecycle-smoke docs. |
| Provider store bytes per real pilot workspace | 25 MB | Manual/operator for now. Current measured matched provider store is 35,249 bytes. |
| Total provider volume used before expansion/review | 250 MB | Manual/operator; current file payload is 36,124 bytes and provisioned volume is 1 GB. |
| Autosave version retention | Latest 30 days of autosaves per branch | Implemented in Gate 3. |
| Manual/import/create/rollback versions | Retained during alpha, operator review if a workspace exceeds 100 retained versions | Manual/operator for now. Current workspace has 29 retained versions. |
| Inactivity TTL | Review cloud copies after 30 days with no activity; delete only after explicit operator/user confirmation | Manual/operator; workspace/account hard delete remains deferred. |
| Paid billing | Disabled | Intentional until Gate 11. |

Reopen Gate 4 before expanding the pilot if any of these happens:

- active external pilot workspaces exceed 10;
- Fly public egress exceeds 50 GB/month;
- Neon compute exceeds 140 CU-hours/month;
- provider volume used exceeds 250 MB;
- average support time exceeds 10 minutes per active workspace-month;
- the app needs more than one always-on Fly machine;
- a paid plan, public pricing page, or Stripe flow is proposed.

## Deferred Before Paid Pricing

- Capture actual Fly Cost Explorer or invoice snapshot for `marklab-relay-alpha`.
- Capture actual Neon usage snapshot: compute CU-hours, database storage, history/PITR storage, and any egress line items.
- Decide whether to add API/provider byte counters before pilot expansion, because current DB state cannot attribute egress or request volume by workspace.
- Rerun the usage report after real external workspaces exist; current p50/p90/p99 values are a one-workspace placeholder.
- Keep paid pricing disabled until a no-loss floor includes fixed infra, variable infra, support cost, payment fees, and target margin.

## Gate 4 Close Recommendation

Gate 4 is closed for the small free pilot under this narrower exit condition:

- Usage report exists and can be rerun by workspace.
- Official public platform rates are recorded.
- Scenario cost model shows the pilot stays cheap under a one-machine architecture.
- Manual pilot guardrails and reopen triggers are documented.
- Paid billing and final free-plan packaging remain deferred.

Do not close Gate 4 for paid launch. The paid no-loss floor still belongs to Gate 11 and must use actual platform billing data plus real support time.
