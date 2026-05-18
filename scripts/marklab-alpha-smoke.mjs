#!/usr/bin/env node

const defaultBaseUrl = 'https://marklab-relay-alpha.fly.dev';

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, '');
}

export function evaluateHealth(body) {
  const failures = [];
  if (body?.ok !== true) failures.push('health.ok');
  if (body?.database?.ready !== true) failures.push('database.ready');
  if (body?.schema?.ready !== true) failures.push('schema.ready');
  if (Array.isArray(body?.schema?.missing) && body.schema.missing.length > 0) {
    failures.push(`schema.missing:${body.schema.missing.join(',')}`);
  }
  if (body?.provider?.ready !== true) failures.push('provider.ready');
  if (body?.provider?.storeReady !== true) failures.push('provider.storeReady');
  return {
    ok: failures.length === 0,
    failures,
  };
}

async function readResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
  return text;
}

async function fetchRequired(url, init = {}) {
  const response = await fetch(url, init);
  const body = await readResponse(response);
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}:${url}:${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

export async function runAlphaSmoke(input = {}) {
  const baseUrl = trimTrailingSlash(input.baseUrl ?? process.env.MARKLAB_ALPHA_BASE_URL ?? defaultBaseUrl);
  const userToken = input.userToken ?? process.env.MARKLAB_USER_TOKEN;
  const workspaceId = input.workspaceId ?? process.env.MARKLAB_WORKSPACE_ID;
  const results = [];

  const health = await fetchRequired(`${baseUrl}/healthz`);
  const evaluatedHealth = evaluateHealth(health);
  if (!evaluatedHealth.ok) throw new Error(`health_not_ready:${evaluatedHealth.failures.join(',')}`);
  results.push({
    check: 'healthz',
    ok: true,
    schemaReady: health.schema?.ready === true,
    providerReady: health.provider?.ready === true,
    providerStoreReady: health.provider?.storeReady === true,
  });

  const collabHtml = await fetchRequired(`${baseUrl}/collab`);
  if (typeof collabHtml !== 'string' || !/id="root"|type="module"|collab-web/u.test(collabHtml)) {
    throw new Error('collab_route_unexpected_html');
  }
  results.push({ check: 'collab_route', ok: true });

  const settingsHtml = await fetchRequired(`${baseUrl}/workspaces/smoke/settings`);
  if (typeof settingsHtml !== 'string' || !/id="root"|type="module"|collab-web/u.test(settingsHtml)) {
    throw new Error('workspace_settings_route_unexpected_html');
  }
  results.push({ check: 'workspace_settings_route', ok: true });

  if (userToken && workspaceId) {
    const billing = await fetchRequired(`${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/billing`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (billing?.billing?.mode !== 'manual') throw new Error('billing_mode_not_manual');
    results.push({
      check: 'manual_billing',
      ok: true,
      planId: billing.billing.plan?.planId ?? null,
      memberSeats: billing.billing.limits?.memberSeats ?? null,
      concurrentGuestEdits: billing.billing.limits?.concurrentGuestEdits ?? null,
    });
  } else {
    results.push({
      check: 'manual_billing',
      ok: true,
      skipped: true,
      reason: 'MARKLAB_USER_TOKEN and MARKLAB_WORKSPACE_ID not set',
    });
  }

  return {
    ok: true,
    baseUrl,
    checkedAt: new Date().toISOString(),
    results,
  };
}

function printUsage() {
  console.log(`Usage:
  MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev node scripts/marklab-alpha-smoke.mjs
  MARKLAB_USER_TOKEN=<ml_user_...> MARKLAB_WORKSPACE_ID=<workspace-id> node scripts/marklab-alpha-smoke.mjs

This smoke is read-only by default. It checks /healthz, /collab, workspace settings shell, and optional manual/free billing state.`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printUsage();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runAlphaSmoke().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
