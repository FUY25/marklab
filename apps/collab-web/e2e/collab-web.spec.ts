import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import { PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS } from '@marklab/shared/src/provider-token-policy';

const docId = 'doc_1';
const branchId = 'branch_1';
const providerDocId = 'provider_doc_e2e';
const fastRefreshExpiresInMs = (PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS + 1) * 1000;

interface RouteOptions {
  tokenExpiresInMs?: number;
  refreshError?: string;
  editCreateError?: string;
  viewError?: string;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

function providerToken(sessionId: string, expiresInMs: number) {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  return {
    providerDocId,
    sessionId,
    authorization: 'full',
    validForSeconds: Math.max(1, Math.ceil(expiresInMs / 1000)),
    issuedAt,
    expiresAt,
    sessionIdentity: {
      sessionId,
      actorType: 'user',
      actorId: sessionId,
      displayName: 'Guest',
      isGuest: true,
    },
    clientToken: {
      docId: providerDocId,
      url: `memory://marklab/${providerDocId}`,
      baseUrl: `memory://marklab/${providerDocId}`,
      token: `client_${sessionId}`,
      authorization: 'full',
    },
  };
}

async function installControlPlaneRoutes(context: BrowserContext, options: RouteOptions = {}) {
  let sessionCounter = 0;
  const tokenExpiresInMs = options.tokenExpiresInMs ?? 10 * 60 * 1000;

  await context.route(`**/api/docs/${docId}/branches/${branchId}/collab/session**`, async (route: Route) => {
    const request = route.request();
    const url = request.url();

    if (url.includes('/provider-token/refresh')) {
      if (options.refreshError) {
        await route.fulfill(jsonResponse({ error: options.refreshError }, 403));
        return;
      }
      const sessionId = url.match(/\/collab\/session\/([^/]+)\/provider-token\/refresh/u)?.[1] ?? 'session_refresh';
      await route.fulfill(jsonResponse({ providerToken: providerToken(sessionId, tokenExpiresInMs) }));
      return;
    }

    const body = JSON.parse(request.postData() ?? '{}') as { mode?: string; displayName?: string };
    if (body.mode === 'view') {
      if (options.viewError) {
        await route.fulfill(jsonResponse({ error: options.viewError }, 403));
        return;
      }
      await route.fulfill(jsonResponse({
        mode: 'view',
        session: { sessionId: 'session_view', clientKind: 'browser', displayName: body.displayName ?? 'Guest' },
        document: {
          docId,
          branchId,
          versionId: null,
          versionNumber: null,
          hash: 'sha256:view',
          markdown: '# View-only\n\nNo provider connection.',
        },
      }));
      return;
    }

    if (options.editCreateError) {
      await route.fulfill(jsonResponse({ error: options.editCreateError }, 403));
      return;
    }

    sessionCounter += 1;
    const sessionId = `session_e2e_${sessionCounter}`;
    await route.fulfill(jsonResponse({
      mode: 'edit',
      session: {
        sessionId,
        clientKind: 'browser',
        displayName: body.displayName ?? 'Guest',
        refreshToken: `refresh_${sessionId}`,
      },
      providerToken: providerToken(sessionId, tokenExpiresInMs),
    }));
  });
}

function editUrl() {
  return `/?mode=edit&docId=${docId}&branchId=${branchId}&token=edit_token`;
}

function viewUrl() {
  return `/?mode=view&docId=${docId}&branchId=${branchId}&token=view_token`;
}

test('edit tab A syncs Markdown text to edit tab B', async ({ browser }) => {
  const context = await browser.newContext();
  await installControlPlaneRoutes(context);
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  await Promise.all([pageA.goto(editUrl()), pageB.goto(editUrl())]);
  await pageA.locator('.cm-content').click();
  await pageA.keyboard.type('# Shared from A');

  await expect(pageB.locator('.cm-content')).toContainText('Shared from A');
  await context.close();
});

test('edit tabs render remote cursor and selection highlight', async ({ browser }) => {
  const context = await browser.newContext();
  await installControlPlaneRoutes(context);
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  await pageA.goto(editUrl());
  await pageA.locator('.cm-content').click();
  await pageA.keyboard.type('Hello world');
  await pageB.goto(editUrl());

  await expect(pageB.locator('.cm-content')).toContainText('Hello world');
  await pageA.locator('.cm-content').click();
  await pageA.keyboard.press('End');
  await expect(pageB.locator('.cm-marklab-remote-caret')).toBeVisible();
  await pageA.keyboard.down('Shift');
  for (let index = 0; index < 5; index += 1) {
    await pageA.keyboard.press('ArrowLeft');
  }
  await pageA.keyboard.up('Shift');
  await expect(pageB.locator('.cm-marklab-remote-selection')).toBeVisible();
  await expect(pageB.locator('.presence-strip')).toContainText('Guest');
  await context.close();
});

test('edit tab queues local edits while offline and flushes them after reconnect', async ({ browser }) => {
  const context = await browser.newContext();
  await installControlPlaneRoutes(context);
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  await Promise.all([pageA.goto(editUrl()), pageB.goto(editUrl())]);
  await expect(pageA.locator('.connection-pill')).toHaveText('Connected');
  await expect(pageB.locator('.connection-pill')).toHaveText('Connected');

  await pageA.evaluate(() => {
    window.dispatchEvent(new CustomEvent('marklab:e2e-provider-status', { detail: { status: 'offline' } }));
  });
  await expect(pageA.locator('.connection-pill')).toHaveText('Offline');

  await pageA.locator('.cm-content').click();
  await pageA.keyboard.type('offline draft');
  await expect(pageA.locator('.cm-content')).toContainText('offline draft');
  await expect(pageB.locator('.cm-content')).not.toContainText('offline draft', { timeout: 300 });

  await pageA.evaluate(() => {
    window.dispatchEvent(new CustomEvent('marklab:e2e-provider-status', { detail: { status: 'connected' } }));
  });
  await expect(pageA.locator('.connection-pill')).toHaveText('Connected');
  await expect(pageB.locator('.cm-content')).toContainText('offline draft');
  await context.close();
});

test('view mode renders a snapshot without provider websocket or editor mount', async ({ browser }) => {
  const context = await browser.newContext();
  await installControlPlaneRoutes(context);
  const page = await context.newPage();
  const websockets: string[] = [];
  page.on('websocket', (socket) => websockets.push(socket.url()));

  await page.goto(viewUrl());

  await expect(page.locator('.markdown-rendered-view')).toContainText('View-only');
  await expect(page.getByRole('heading', { name: 'View-only' })).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(websockets.filter((url) => url.includes('/d/') || url.includes(providerDocId))).toEqual([]);
  await context.close();
});

test('revoked view session surfaces unavailable state before any provider connection', async ({ browser }) => {
  const context = await browser.newContext();
  await installControlPlaneRoutes(context, { viewError: 'grant_revoked' });
  const page = await context.newPage();
  const websockets: string[] = [];
  page.on('websocket', (socket) => websockets.push(socket.url()));

  await page.goto(viewUrl());

  await expect(page.getByRole('status')).toContainText('grant_revoked');
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(websockets.filter((url) => url.includes('/d/') || url.includes(providerDocId))).toEqual([]);
  await context.close();
});

test('edit session creation denials surface unavailable states', async ({ browser }) => {
  for (const error of ['member_seat_limit_exceeded', 'guest_session_quota_exceeded', 'grant_expired']) {
    const context = await browser.newContext();
    await installControlPlaneRoutes(context, { editCreateError: error });
    const page = await context.newPage();

    await page.goto(editUrl());

    await expect(page.getByRole('status')).toContainText(error);
    await expect(page.locator('.connection-pill')).toHaveText('Unavailable');
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await context.close();
  }
});

test('revoked edit session surfaces unavailable state', async ({ browser }) => {
  const context = await browser.newContext();
  await installControlPlaneRoutes(context, {
    tokenExpiresInMs: fastRefreshExpiresInMs,
    refreshError: 'provider_token_revoked',
  });
  const page = await context.newPage();

  await page.goto(editUrl());

  await expect(page.getByRole('status')).toContainText('provider_token_revoked');
  await expect(page.locator('.connection-pill')).toHaveText('Unavailable');
  await context.close();
});

test('role downgrade during refresh surfaces unavailable state', async ({ browser }) => {
  const context = await browser.newContext();
  await installControlPlaneRoutes(context, {
    tokenExpiresInMs: fastRefreshExpiresInMs,
    refreshError: 'forbidden',
  });
  const page = await context.newPage();

  await page.goto(editUrl());

  await expect(page.getByRole('status')).toContainText('forbidden');
  await expect(page.locator('.connection-pill')).toHaveText('Unavailable');
  await context.close();
});
