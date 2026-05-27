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

export function extractStaticAssetPaths(html, assetPrefix) {
  if (typeof html !== 'string') return [];
  return Array.from(html.matchAll(/\b(?:src|href)="([^"]+)"/gu))
    .map((match) => match[1])
    .filter((value) => typeof value === 'string' && value.startsWith(assetPrefix));
}

export function extractModuleAssetPaths(html, assetPrefix) {
  if (typeof html !== 'string') return [];
  return Array.from(html.matchAll(/<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*>/giu))
    .map((match) => match[1])
    .filter((value) => typeof value === 'string' && value.startsWith(assetPrefix));
}

export function evaluateStaticShellHtml(html, input) {
  const failures = [];
  if (typeof html !== 'string') {
    return { ok: false, failures: ['html.string'] };
  }
  if (!html.includes(`<title>${input.requiredTitle}</title>`)) {
    failures.push(`html.title:${input.requiredTitle}`);
  }
  if (!/<div\s+id="root"\s*><\/div>/iu.test(html)) {
    failures.push('html.root');
  }
  if (extractModuleAssetPaths(html, input.assetPrefix).length === 0) {
    failures.push(`html.moduleAssetPrefix:${input.assetPrefix}`);
  }
  if (extractStaticAssetPaths(html, input.assetPrefix).length === 0) {
    failures.push(`html.assetPrefix:${input.assetPrefix}`);
  }
  for (const href of input.requiredHrefs ?? []) {
    if (!html.includes(`href="${href}"`)) {
      failures.push(`html.href:${href}`);
    }
  }
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
  const requireAuthenticatedSmoke = input.requireAuthenticatedSmoke ?? process.env.MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE === '1';
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
  const collabShell = evaluateStaticShellHtml(collabHtml, {
    requiredTitle: 'MarkLab Collaborator',
    assetPrefix: '/collab-web/assets/',
    requiredHrefs: [
      '/collab-web/favicon.png',
      '/collab-web/apple-touch-icon.png',
      '/collab-web/site.webmanifest',
    ],
  });
  if (!collabShell.ok) throw new Error(`collab_route_unexpected_html:${collabShell.failures.join(',')}`);
  const collabAssets = extractStaticAssetPaths(collabHtml, '/collab-web/assets/');
  for (const assetPath of collabAssets) {
    await fetchRequired(new URL(assetPath, baseUrl).toString());
  }
  results.push({ check: 'collab_route', ok: true, assetCount: collabAssets.length });

  const settingsHtml = await fetchRequired(`${baseUrl}/workspaces/smoke/settings`);
  const settingsShell = evaluateStaticShellHtml(settingsHtml, {
    requiredTitle: 'MarkLab Collaborator',
    assetPrefix: '/collab-web/assets/',
    requiredHrefs: [
      '/collab-web/favicon.png',
      '/collab-web/apple-touch-icon.png',
      '/collab-web/site.webmanifest',
    ],
  });
  if (!settingsShell.ok) throw new Error(`workspace_settings_route_unexpected_html:${settingsShell.failures.join(',')}`);
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
  } else if (requireAuthenticatedSmoke) {
    throw new Error('authenticated_smoke_required:MARKLAB_USER_TOKEN and MARKLAB_WORKSPACE_ID must both be set');
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
  MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 MARKLAB_USER_TOKEN=<ml_user_...> MARKLAB_WORKSPACE_ID=<workspace-id> node scripts/marklab-alpha-smoke.mjs

This smoke is read-only by default. It checks /healthz, the real /collab static shell and assets, workspace settings shell, and optional manual/free billing state. Set MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 for launch gates.`);
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
