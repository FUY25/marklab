#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = requireFromApi('pg');

const bytesPerGiB = 1024 ** 3;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected_arg:${arg}`);
    const key = arg.slice(2);
    if (key === 'help' || key === 'json') {
      args[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`missing_value:${arg}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function envOrArg(args, argName, envName) {
  const value = args[argName] ?? process.env[envName];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args, argName, envName) {
  const raw = envOrArg(args, argName, envName);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_number:${argName}`);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sumDirectoryBytes(directoryPath) {
  let total = 0;
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      total += sumDirectoryBytes(entryPath);
    } else {
      total += stat.size;
    }
  }
  return total;
}

function loadProviderStoreBytes(args) {
  const jsonPath = envOrArg(args, 'provider-store-json', 'MARKLAB_PROVIDER_STORE_BYTES_JSON');
  const storePath = envOrArg(args, 'provider-store-path', 'MARKLAB_PROVIDER_STORE_PATH');
  const bytesByProviderDocId = new Map();
  const warnings = [];
  let source = 'none';

  if (jsonPath) {
    source = `json:${jsonPath}`;
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const entries = Array.isArray(parsed)
      ? parsed.map((item) => [
        item.providerDocId ?? item.provider_doc_id ?? item.id,
        item.bytes ?? item.sizeBytes ?? item.size_bytes,
      ])
      : Object.entries(parsed);
    for (const [providerDocId, bytes] of entries) {
      if (typeof providerDocId !== 'string' || !providerDocId) {
        warnings.push('provider_store_json_entry_missing_provider_doc_id');
        continue;
      }
      const numericBytes = Number(bytes);
      if (!Number.isFinite(numericBytes) || numericBytes < 0) {
        warnings.push(`provider_store_json_entry_invalid_bytes:${providerDocId}`);
        continue;
      }
      bytesByProviderDocId.set(providerDocId, numericBytes);
    }
  } else if (storePath) {
    source = `path:${storePath}`;
    const entries = fs.readdirSync(storePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const providerDocId = entry.name;
      bytesByProviderDocId.set(providerDocId, sumDirectoryBytes(path.join(storePath, providerDocId)));
    }
  }

  return {
    source,
    bytesByProviderDocId,
    warnings,
  };
}

function percentile(values, percentileValue) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const position = (finite.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return finite[lower];
  const weight = position - lower;
  return finite[lower] * (1 - weight) + finite[upper] * weight;
}

function percentileSet(values) {
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
  };
}

function compactCostConfig(args) {
  return {
    monthlyFixedCostUsd: optionalNumber(args, 'monthly-fixed-cost-usd', 'MARKLAB_MONTHLY_FIXED_COST_USD'),
    neonStorageGbMonthUsd: optionalNumber(args, 'neon-storage-gb-month-usd', 'MARKLAB_NEON_STORAGE_GB_MONTH_USD'),
    providerStorageGbMonthUsd: optionalNumber(args, 'provider-storage-gb-month-usd', 'MARKLAB_PROVIDER_STORAGE_GB_MONTH_USD'),
    egressGbUsd: optionalNumber(args, 'egress-gb-usd', 'MARKLAB_EGRESS_GB_USD'),
    supportMinutesPerWorkspace: optionalNumber(args, 'support-minutes-per-workspace', 'MARKLAB_SUPPORT_MINUTES_PER_WORKSPACE'),
    supportHourlyUsd: optionalNumber(args, 'support-hourly-usd', 'MARKLAB_SUPPORT_HOURLY_USD'),
    paymentPercent: optionalNumber(args, 'payment-percent', 'MARKLAB_PAYMENT_PERCENT'),
    paymentFixedUsd: optionalNumber(args, 'payment-fixed-usd', 'MARKLAB_PAYMENT_FIXED_USD'),
    targetGrossMargin: optionalNumber(args, 'target-gross-margin', 'MARKLAB_TARGET_GROSS_MARGIN'),
  };
}

function estimateWorkspaceCost(row, activeWorkspaceCount, costConfig) {
  const missing = [];
  const monthlyFixedCostUsd = costConfig.monthlyFixedCostUsd ?? 0;
  const fixedShareUsd = activeWorkspaceCount > 0 ? monthlyFixedCostUsd / activeWorkspaceCount : 0;
  const neonStorageUsd = costConfig.neonStorageGbMonthUsd === undefined
    ? 0
    : (row.neonRetainedBytes / bytesPerGiB) * costConfig.neonStorageGbMonthUsd;
  const providerStorageUsd = costConfig.providerStorageGbMonthUsd === undefined
    ? 0
    : (row.providerStoreBytes / bytesPerGiB) * costConfig.providerStorageGbMonthUsd;
  const egressUsd = costConfig.egressGbUsd === undefined || row.estimatedEgressBytes === null
    ? 0
    : (row.estimatedEgressBytes / bytesPerGiB) * costConfig.egressGbUsd;
  const supportUsd =
    costConfig.supportMinutesPerWorkspace !== undefined && costConfig.supportHourlyUsd !== undefined
      ? (costConfig.supportMinutesPerWorkspace / 60) * costConfig.supportHourlyUsd
      : 0;

  if (costConfig.monthlyFixedCostUsd === undefined) missing.push('monthly-fixed-cost-usd');
  if (costConfig.neonStorageGbMonthUsd === undefined) missing.push('neon-storage-gb-month-usd');
  if (costConfig.providerStorageGbMonthUsd === undefined) missing.push('provider-storage-gb-month-usd');
  if (costConfig.egressGbUsd === undefined) missing.push('egress-gb-usd');
  if (row.estimatedEgressBytes === null) missing.push('estimated-egress-bytes');
  if (costConfig.supportMinutesPerWorkspace === undefined) missing.push('support-minutes-per-workspace');
  if (costConfig.supportHourlyUsd === undefined) missing.push('support-hourly-usd');

  const infraAndSupportUsd = fixedShareUsd + neonStorageUsd + providerStorageUsd + egressUsd + supportUsd;
  const hasCompleteNoLossInputs = missing.length === 0;
  const paymentPercent = costConfig.paymentPercent ?? 0;
  const paymentFixedUsd = costConfig.paymentFixedUsd ?? 0;
  const paymentDenominator = 1 - paymentPercent;
  const noLossMonthlyPriceUsd = hasCompleteNoLossInputs && paymentDenominator > 0
    ? (infraAndSupportUsd + paymentFixedUsd) / paymentDenominator
    : null;
  const targetGrossMargin = costConfig.targetGrossMargin;
  const marginDenominator = targetGrossMargin === undefined ? null : 1 - paymentPercent - targetGrossMargin;
  const targetMarginMonthlyPriceUsd = hasCompleteNoLossInputs && marginDenominator && marginDenominator > 0
    ? (infraAndSupportUsd + paymentFixedUsd) / marginDenominator
    : null;

  return {
    fixedShareUsd,
    neonStorageUsd,
    providerStorageUsd,
    egressUsd,
    supportUsd,
    infraAndSupportUsd,
    noLossMonthlyPriceUsd,
    targetMarginMonthlyPriceUsd,
    missingInputs: missing,
  };
}

async function fetchWorkspaceRows(client, input) {
  const result = await client.query(
    `with workspace_base as (
       select w.id,
              w.name,
              w.created_at,
              w.updated_at,
              coalesce(s.plan_id, 'free') as plan_id,
              coalesce(s.status, 'manual') as subscription_status,
              coalesce(s.billing_mode, 'manual') as billing_mode
         from workspaces w
         left join subscriptions s on s.workspace_id = w.id
     ),
     doc_metrics as (
       select d.workspace_id,
              count(distinct d.id) as active_document_count,
              count(distinct b.id) as branch_count,
              count(distinct st.provider_doc_id) filter (where st.provider_doc_id is not null) as provider_document_count,
              coalesce(sum(octet_length(st.current_markdown)), 0) as current_markdown_bytes,
              coalesce(sum(octet_length(st.yjs_state)), 0) as current_yjs_state_bytes,
              array_remove(array_agg(distinct st.provider_doc_id), null) as provider_doc_ids,
              max(greatest(d.updated_at, coalesce(st.updated_at, d.updated_at))) as last_document_activity_at
         from documents d
         left join document_branches b on b.doc_id = d.id
         left join document_branch_states st on st.branch_id = b.id
        where d.workspace_id is not null
        group by d.workspace_id
     ),
     version_metrics as (
       select d.workspace_id,
              count(*) as version_count,
              count(*) filter (where v.operation = 'autosave') as autosave_version_count,
              count(*) filter (where v.operation = 'manual_save') as manual_version_count,
              coalesce(sum(octet_length(v.markdown_snapshot)), 0) as version_snapshot_bytes,
              max(v.created_at) as last_version_activity_at
         from document_versions v
         join documents d on d.id = v.doc_id
        where d.workspace_id is not null
        group by d.workspace_id
     ),
     access_metrics as (
       select d.workspace_id,
              count(distinct g.id) as access_grant_count,
              count(distinct g.id) filter (where g.revoked_at is null and (g.expires_at is null or g.expires_at > now())) as active_access_grant_count,
              count(distinct s.id) as access_session_count,
              max(greatest(g.created_at, coalesce(s.last_seen_at, g.created_at))) as last_access_activity_at
         from documents d
         left join document_access_grants g on g.doc_id = d.id
         left join document_access_sessions s on s.grant_id = g.id
        where d.workspace_id is not null
        group by d.workspace_id
     ),
     collab_metrics as (
       select d.workspace_id,
              count(distinct cs.id) as collab_session_count,
              count(distinct cs.id) filter (where cs.mode = 'edit' and cs.is_guest) as guest_edit_session_count,
              count(distinct cs.id) filter (where cs.mode = 'edit' and cs.is_guest and cs.last_seen_at >= $1::timestamptz) as guest_edit_session_count_window,
              coalesce(sum(greatest(extract(epoch from (coalesce(cs.last_seen_at, cs.created_at) - cs.created_at)) / 60, 0)), 0) as collab_session_minutes_all_time,
              coalesce(sum(
                case
                  when cs.last_seen_at >= $1::timestamptz
                  then greatest(extract(epoch from (coalesce(cs.last_seen_at, cs.created_at) - greatest(cs.created_at, $1::timestamptz))) / 60, 0)
                  else 0
                end
              ), 0) as collab_session_minutes_window,
              coalesce(sum(
                case
                  when cs.mode = 'edit' and cs.is_guest and cs.last_seen_at >= $1::timestamptz
                  then greatest(extract(epoch from (coalesce(cs.last_seen_at, cs.created_at) - greatest(cs.created_at, $1::timestamptz))) / 60, 0)
                  else 0
                end
              ), 0) as guest_edit_session_minutes_window,
              max(cs.last_seen_at) as last_collab_activity_at
         from documents d
         left join collab_sessions cs on cs.doc_id = d.id
        where d.workspace_id is not null
        group by d.workspace_id
     ),
     token_metrics as (
       select d.workspace_id,
              count(distinct pti.id) as provider_token_issuance_count,
              count(distinct pti.id) filter (where pti.issued_at >= $1::timestamptz) as provider_token_issuance_count_window,
              count(distinct ptr.id) as provider_token_refresh_count,
              count(distinct ptr.id) filter (where ptr.created_at >= $1::timestamptz) as provider_token_refresh_count_window,
              max(greatest(coalesce(pti.issued_at, '-infinity'::timestamptz), coalesce(ptr.created_at, '-infinity'::timestamptz))) as last_token_activity_at
         from documents d
         left join provider_token_issuances pti on pti.doc_id = d.id
         left join collab_sessions cs on cs.doc_id = d.id
         left join provider_token_refreshes ptr on ptr.session_id = cs.id
        where d.workspace_id is not null
        group by d.workspace_id
     ),
     member_metrics as (
       select workspace_id,
              count(*) as member_count
         from workspace_members
        group by workspace_id
     )
     select wb.id::text as workspace_id,
            wb.name as workspace_name,
            wb.created_at,
            wb.updated_at,
            wb.plan_id,
            wb.subscription_status,
            wb.billing_mode,
            coalesce(mm.member_count, 0) as member_count,
            coalesce(dm.active_document_count, 0) as active_document_count,
            coalesce(dm.branch_count, 0) as branch_count,
            coalesce(dm.provider_document_count, 0) as provider_document_count,
            coalesce(dm.current_markdown_bytes, 0) as current_markdown_bytes,
            coalesce(dm.current_yjs_state_bytes, 0) as current_yjs_state_bytes,
            coalesce(dm.provider_doc_ids, array[]::text[]) as provider_doc_ids,
            coalesce(vm.version_count, 0) as version_count,
            coalesce(vm.autosave_version_count, 0) as autosave_version_count,
            coalesce(vm.manual_version_count, 0) as manual_version_count,
            coalesce(vm.version_snapshot_bytes, 0) as version_snapshot_bytes,
            coalesce(am.access_grant_count, 0) as access_grant_count,
            coalesce(am.active_access_grant_count, 0) as active_access_grant_count,
            coalesce(am.access_session_count, 0) as access_session_count,
            coalesce(cm.collab_session_count, 0) as collab_session_count,
            coalesce(cm.guest_edit_session_count, 0) as guest_edit_session_count,
            coalesce(cm.guest_edit_session_count_window, 0) as guest_edit_session_count_window,
            coalesce(cm.collab_session_minutes_all_time, 0) as collab_session_minutes_all_time,
            coalesce(cm.collab_session_minutes_window, 0) as collab_session_minutes_window,
            coalesce(cm.guest_edit_session_minutes_window, 0) as guest_edit_session_minutes_window,
            coalesce(tm.provider_token_issuance_count, 0) as provider_token_issuance_count,
            coalesce(tm.provider_token_issuance_count_window, 0) as provider_token_issuance_count_window,
            coalesce(tm.provider_token_refresh_count, 0) as provider_token_refresh_count,
            coalesce(tm.provider_token_refresh_count_window, 0) as provider_token_refresh_count_window,
            greatest(
              coalesce(dm.last_document_activity_at, wb.updated_at),
              coalesce(vm.last_version_activity_at, wb.updated_at),
              coalesce(am.last_access_activity_at, wb.updated_at),
              coalesce(cm.last_collab_activity_at, wb.updated_at),
              coalesce(tm.last_token_activity_at, wb.updated_at),
              wb.updated_at
            ) as last_active_at
       from workspace_base wb
       left join member_metrics mm on mm.workspace_id = wb.id
       left join doc_metrics dm on dm.workspace_id = wb.id
       left join version_metrics vm on vm.workspace_id = wb.id
       left join access_metrics am on am.workspace_id = wb.id
       left join collab_metrics cm on cm.workspace_id = wb.id
       left join token_metrics tm on tm.workspace_id = wb.id
      where ($2::uuid is null or wb.id = $2::uuid)
      order by last_active_at desc, wb.created_at desc`,
    [input.sinceIso, input.workspaceId ?? null],
  );
  return result.rows;
}

async function fetchDatabaseSnapshot(client) {
  const database = await client.query(
    `select current_database() as database_name,
            pg_database_size(current_database()) as database_bytes,
            now() as measured_at`,
  );
  const relations = await client.query(
    `select c.relname as relation_name,
            c.relkind as relation_kind,
            pg_total_relation_size(c.oid) as total_bytes
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'm', 'i')
      order by pg_total_relation_size(c.oid) desc
      limit 30`,
  );
  return {
    databaseName: database.rows[0]?.database_name ?? null,
    databaseBytes: toNumber(database.rows[0]?.database_bytes),
    measuredAt: toIso(database.rows[0]?.measured_at),
    largestRelations: relations.rows.map((row) => ({
      relationName: row.relation_name,
      relationKind: row.relation_kind,
      totalBytes: toNumber(row.total_bytes),
    })),
  };
}

function normalizeWorkspaceRows(rows, input) {
  const providerStore = input.providerStore;
  return rows.map((row) => {
    const providerDocIds = Array.isArray(row.provider_doc_ids) ? row.provider_doc_ids : [];
    let providerStoreBytes = 0;
    const missingProviderStoreDocIds = [];
    for (const providerDocId of providerDocIds) {
      if (providerStore.bytesByProviderDocId.has(providerDocId)) {
        providerStoreBytes += providerStore.bytesByProviderDocId.get(providerDocId);
      } else if (providerStore.source !== 'none') {
        missingProviderStoreDocIds.push(providerDocId);
      }
    }
    const currentMarkdownBytes = toNumber(row.current_markdown_bytes);
    const currentYjsStateBytes = toNumber(row.current_yjs_state_bytes);
    const versionSnapshotBytes = toNumber(row.version_snapshot_bytes);
    const neonRetainedBytes = currentMarkdownBytes + currentYjsStateBytes + versionSnapshotBytes;
    const retainedStorageBytes = neonRetainedBytes + providerStoreBytes;
    const lastActiveAt = toIso(row.last_active_at);
    const activeInWindow = lastActiveAt ? new Date(lastActiveAt) >= new Date(input.sinceIso) : false;
    return {
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      planId: row.plan_id,
      subscriptionStatus: row.subscription_status,
      billingMode: row.billing_mode,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      lastActiveAt,
      activeInWindow,
      memberCount: toNumber(row.member_count),
      activeDocumentCount: toNumber(row.active_document_count),
      branchCount: toNumber(row.branch_count),
      providerDocumentCount: toNumber(row.provider_document_count),
      providerDocIds,
      currentMarkdownBytes,
      currentYjsStateBytes,
      versionCount: toNumber(row.version_count),
      autosaveVersionCount: toNumber(row.autosave_version_count),
      manualVersionCount: toNumber(row.manual_version_count),
      versionSnapshotBytes,
      neonRetainedBytes,
      providerStoreBytes,
      missingProviderStoreDocIds,
      retainedStorageBytes,
      accessGrantCount: toNumber(row.access_grant_count),
      activeAccessGrantCount: toNumber(row.active_access_grant_count),
      accessSessionCount: toNumber(row.access_session_count),
      collabSessionCount: toNumber(row.collab_session_count),
      guestEditSessionCount: toNumber(row.guest_edit_session_count),
      guestEditSessionCountWindow: toNumber(row.guest_edit_session_count_window),
      collabSessionMinutesAllTime: toNumber(row.collab_session_minutes_all_time),
      collabSessionMinutesWindow: toNumber(row.collab_session_minutes_window),
      guestEditSessionMinutesWindow: toNumber(row.guest_edit_session_minutes_window),
      providerTokenIssuanceCount: toNumber(row.provider_token_issuance_count),
      providerTokenIssuanceCountWindow: toNumber(row.provider_token_issuance_count_window),
      providerTokenRefreshCount: toNumber(row.provider_token_refresh_count),
      providerTokenRefreshCountWindow: toNumber(row.provider_token_refresh_count_window),
      apiRequestCount: null,
      estimatedEgressBytes: null,
    };
  });
}

function summarize(workspaces, costConfig) {
  const activeWorkspaces = workspaces.filter((workspace) => workspace.activeInWindow);
  const activeCount = activeWorkspaces.length;
  const totals = workspaces.reduce((accumulator, workspace) => {
    accumulator.activeDocumentCount += workspace.activeDocumentCount;
    accumulator.providerDocumentCount += workspace.providerDocumentCount;
    accumulator.currentMarkdownBytes += workspace.currentMarkdownBytes;
    accumulator.currentYjsStateBytes += workspace.currentYjsStateBytes;
    accumulator.versionSnapshotBytes += workspace.versionSnapshotBytes;
    accumulator.neonRetainedBytes += workspace.neonRetainedBytes;
    accumulator.providerStoreBytes += workspace.providerStoreBytes;
    accumulator.retainedStorageBytes += workspace.retainedStorageBytes;
    accumulator.collabSessionMinutesWindow += workspace.collabSessionMinutesWindow;
    accumulator.guestEditSessionCountWindow += workspace.guestEditSessionCountWindow;
    accumulator.providerTokenRefreshCountWindow += workspace.providerTokenRefreshCountWindow;
    return accumulator;
  }, {
    activeDocumentCount: 0,
    providerDocumentCount: 0,
    currentMarkdownBytes: 0,
    currentYjsStateBytes: 0,
    versionSnapshotBytes: 0,
    neonRetainedBytes: 0,
    providerStoreBytes: 0,
    retainedStorageBytes: 0,
    collabSessionMinutesWindow: 0,
    guestEditSessionCountWindow: 0,
    providerTokenRefreshCountWindow: 0,
  });

  const workspacesWithCost = workspaces.map((workspace) => ({
    ...workspace,
    estimatedMonthlyCost: estimateWorkspaceCost(workspace, activeCount, costConfig),
  }));
  const activeCosts = workspacesWithCost
    .filter((workspace) => workspace.activeInWindow)
    .map((workspace) => workspace.estimatedMonthlyCost.infraAndSupportUsd);
  const noLossFloors = workspacesWithCost
    .filter((workspace) => workspace.activeInWindow)
    .map((workspace) => workspace.estimatedMonthlyCost.noLossMonthlyPriceUsd)
    .filter((value) => value !== null);

  return {
    workspacesWithCost,
    summary: {
      workspaceCount: workspaces.length,
      activeWorkspaceCount: activeCount,
      totals,
      activeWorkspaceUsagePercentiles: {
        activeDocumentCount: percentileSet(activeWorkspaces.map((workspace) => workspace.activeDocumentCount)),
        providerDocumentCount: percentileSet(activeWorkspaces.map((workspace) => workspace.providerDocumentCount)),
        retainedStorageBytes: percentileSet(activeWorkspaces.map((workspace) => workspace.retainedStorageBytes)),
        neonRetainedBytes: percentileSet(activeWorkspaces.map((workspace) => workspace.neonRetainedBytes)),
        providerStoreBytes: percentileSet(activeWorkspaces.map((workspace) => workspace.providerStoreBytes)),
        collabSessionMinutesWindow: percentileSet(activeWorkspaces.map((workspace) => workspace.collabSessionMinutesWindow)),
        guestEditSessionCountWindow: percentileSet(activeWorkspaces.map((workspace) => workspace.guestEditSessionCountWindow)),
        providerTokenRefreshCountWindow: percentileSet(activeWorkspaces.map((workspace) => workspace.providerTokenRefreshCountWindow)),
      },
      costEstimate: {
        activeWorkspaceCount: activeCount,
        infraAndSupportMonthlyUsd: percentileSet(activeCosts),
        noLossMonthlyPriceUsd: percentileSet(noLossFloors),
        missingInputs: Array.from(new Set(workspacesWithCost.flatMap((workspace) => workspace.estimatedMonthlyCost.missingInputs))).sort(),
      },
      unavailableMeters: {
        apiRequestCount: 'No request log or API request meter table exists in the MarkLab schema.',
        estimatedEgressBytes: 'No per-workspace egress meter exists in the MarkLab schema or Fly CLI output used by this report.',
      },
    },
  };
}

function printUsage() {
  console.log(`Usage:
  DATABASE_URL=<postgres-url> node scripts/marklab-workspace-usage-report.mjs [options]

Options:
  --workspace-id <uuid>                    Limit to one workspace.
  --since-days <days>                      Activity window for monthly usage. Default: 30.
  --provider-store-path <path>             Read provider doc byte sizes from local Y-Sweet store directories.
  --provider-store-json <path>             Read provider byte mapping as {"providerDocId": bytes}.
  --output <path>                          Write JSON report to a file and still print it.
  --monthly-fixed-cost-usd <number>        Fixed monthly infra/bill cost to allocate across active workspaces.
  --neon-storage-gb-month-usd <number>     Neon storage rate assumption.
  --provider-storage-gb-month-usd <number> Fly/provider volume storage rate assumption.
  --egress-gb-usd <number>                 Egress rate assumption.
  --support-minutes-per-workspace <number> Support minutes per active workspace per month.
  --support-hourly-usd <number>            Loaded support hourly cost.
  --payment-percent <number>               Payment processor fraction, for example 0.029.
  --payment-fixed-usd <number>             Payment processor fixed fee.
  --target-gross-margin <number>           Target margin fraction, for example 0.7.

The script is read-only. It does not print DATABASE_URL or token values.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const sinceDays = optionalNumber(args, 'since-days', 'MARKLAB_USAGE_SINCE_DAYS') ?? 30;
  if (sinceDays <= 0) throw new Error('invalid_number:since-days');
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const workspaceId = envOrArg(args, 'workspace-id', 'MARKLAB_WORKSPACE_ID');
  const providerStore = loadProviderStoreBytes(args);
  const costConfig = compactCostConfig(args);
  const client = new Client({ connectionString: requiredEnv('DATABASE_URL') });

  await client.connect();
  try {
    const [rawRows, databaseSnapshot] = await Promise.all([
      fetchWorkspaceRows(client, { sinceIso, workspaceId }),
      fetchDatabaseSnapshot(client),
    ]);
    const workspaces = normalizeWorkspaceRows(rawRows, { sinceIso, providerStore });
    const { workspacesWithCost, summary } = summarize(workspaces, costConfig);
    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      sampleWindow: {
        sinceDays,
        since: sinceIso,
      },
      inputs: {
        workspaceId: workspaceId ?? null,
        providerStore: {
          source: providerStore.source,
          providerDocCount: providerStore.bytesByProviderDocId.size,
          totalBytes: Array.from(providerStore.bytesByProviderDocId.values()).reduce((sum, value) => sum + value, 0),
          warnings: providerStore.warnings,
        },
        costConfig,
      },
      databaseSnapshot,
      summary,
      workspaces: workspacesWithCost,
    };
    const output = JSON.stringify(report, null, 2);
    if (args.output) fs.writeFileSync(args.output, `${output}\n`);
    console.log(output);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
