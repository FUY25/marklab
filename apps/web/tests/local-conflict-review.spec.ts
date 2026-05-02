import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const webUrl = 'http://127.0.0.1:5175';
const apiUrl = process.env.MARKLAB_E2E_API_URL ?? 'http://127.0.0.1:3011';

const conflict = {
  conflictId: 'conflict-1',
  relayRoomId: 'relay-room-1',
  localDocId: 'local-doc-1',
  localPath: '/tmp/conflicted.md',
  baseMarkdown: '# Base\n\nOriginal shared text.\n',
  baseYjsStateBase64: null,
  baseHash: 'base-hash',
  localMarkdown: '# Local\n\nOffline local change.\n',
  localYjsStateBase64: 'bG9jYWw=',
  localHash: 'local-hash',
  sharedMarkdown: '# Shared\n\nOnline shared change.\n',
  sharedYjsStateBase64: 'c2hhcmVk',
  sharedHash: 'shared-hash',
  sharedStateFingerprint: 'shared-fingerprint',
  sharedRevision: 7,
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:01:00.000Z',
  status: 'open',
};

async function installConflictApiMocks(page: Page) {
  let flushCalls = 0;
  let resolvePayload: unknown = null;
  let useLocalCalls = 0;
  let useLocalPayload: unknown = null;

  await page.route(`${apiUrl}/api/local/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === 'GET' && path === '/api/local/document') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          localDocId: conflict.localDocId,
          displayName: 'conflicted.md',
          absolutePath: conflict.localPath,
          roomName: 'local-room-1',
          hash: conflict.localHash,
          conflict: 'Relay reconnect conflict. Review needed before syncing resumes.',
          historyLoadError: null,
        }),
      });
      return;
    }

    if (method === 'GET' && path === '/api/local/conflicts/current') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ conflict }),
      });
      return;
    }

    if (method === 'GET' && path === `/api/local/conflicts/${conflict.conflictId}/ai-prompt`) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          prompt:
            'You are helping resolve a Markdown collaboration conflict.\n\n<my_local_offline_markdown>\nOffline local change.\n</my_local_offline_markdown>',
        }),
      });
      return;
    }

    if (method === 'POST' && path === `/api/local/conflicts/${conflict.conflictId}/resolve`) {
      resolvePayload = request.postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          conflictId: conflict.conflictId,
          status: 'resolved',
          hash: 'resolved-hash',
          sharedRevision: 8,
        }),
      });
      return;
    }

    if (method === 'POST' && path === `/api/local/conflicts/${conflict.conflictId}/use-local`) {
      useLocalCalls += 1;
      useLocalPayload = request.postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          conflictId: conflict.conflictId,
          status: 'resolved',
          hash: 'local-hash',
          sharedRevision: 8,
        }),
      });
      return;
    }

    if (method === 'POST' && path === '/api/local/flush') {
      flushCalls += 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'conflict_required' }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not_mocked', path, method }),
    });
  });

  return {
    flushCalls: () => flushCalls,
    resolvePayload: () => resolvePayload,
    useLocalCalls: () => useLocalCalls,
    useLocalPayload: () => useLocalPayload,
  };
}

test('reviews an open local reconnect conflict without enabling editor writes', async ({ page, context }) => {
  const api = await installConflictApiMocks(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: webUrl });

  await page.goto(`${webUrl}/local#token=local-token`);

  const drawer = page.getByTestId('conflict-review-drawer');
  await expect(drawer.getByRole('heading', { name: 'Sync paused' })).toBeVisible();
  await expect(drawer).toContainText('This file changed locally while the shared session also changed.');
  await expect(drawer).toContainText('Both original versions were snapshotted and remain recoverable.');
  await expect(drawer.getByRole('region', { name: 'Shared version', exact: true })).toContainText('Online shared change.');
  await expect(drawer.getByRole('region', { name: 'My local version', exact: true })).toContainText('Offline local change.');
  await expect(drawer.getByRole('region', { name: 'Base version', exact: true })).toContainText('Original shared text.');
  await expect(drawer.getByRole('region', { name: 'Resolution choices', exact: true })).toContainText(
    'Choose a resolution',
  );
  await expect(drawer.getByRole('region', { name: 'AI merge', exact: true })).toContainText('Merged Markdown output');
  await expect(
    drawer.locator('.document-drawer-section').evaluateAll((sections) =>
      sections
        .map((section) => section.getAttribute('aria-label'))
        .filter(Boolean),
    ),
  ).resolves.toEqual([
    'Conflict summary',
    'My local version',
    'Shared version',
    'Base version',
    'Resolution choices',
    'Use my local version confirmation',
    'Use shared version confirmation',
    'AI merge',
  ]);
  await expect(page.getByTestId('milkdown-editor')).toHaveCount(0);
  expect(api.flushCalls()).toBe(0);

  await drawer.getByRole('button', { name: 'Copy AI merge prompt' }).click();
  await expect(drawer).toContainText('AI merge prompt copied.');
  await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toContain('<my_local_offline_markdown>');

  const useShared = drawer.getByRole('button', { name: 'Use shared version', exact: true });
  await expect(useShared).toBeDisabled();
  await drawer.getByLabel('Type USE SHARED to confirm').fill('USE SHARED');
  await expect(useShared).toBeEnabled();

  const useLocal = drawer.getByRole('button', { name: 'Use my local version', exact: true });
  await expect(useLocal).toBeDisabled();
  await drawer.getByLabel('Type USE LOCAL to confirm').fill('USE LOCAL');
  await expect(useLocal).toBeEnabled();

  await drawer.getByRole('button', { name: 'Keep paused' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('local-conflict-paused')).toContainText('Sync paused');
  await expect(page.getByTestId('milkdown-editor')).toHaveCount(0);
  expect(api.useLocalCalls()).toBe(0);
  expect(api.flushCalls()).toBe(0);

  await page.reload();
  await expect(page.getByTestId('conflict-review-drawer')).toContainText('Sync paused');
  await expect(page.getByTestId('milkdown-editor')).toHaveCount(0);
  expect(api.flushCalls()).toBe(0);
});

test('posts pasted resolved Markdown with the conflict revision guard', async ({ page }) => {
  const api = await installConflictApiMocks(page);

  await page.goto(`${webUrl}/local#token=local-token`);

  const drawer = page.getByTestId('conflict-review-drawer');
  await drawer.getByRole('textbox', { name: 'Merged Markdown output' }).fill('# Resolved\n\nMerged final text.\n');
  await drawer.getByRole('button', { name: 'Apply AI merge' }).click();

  expect(api.resolvePayload()).toEqual({
    markdown: '# Resolved\n\nMerged final text.\n',
    expectedSharedRevision: conflict.sharedRevision,
    expectedSharedHash: conflict.sharedHash,
  });
});

test('posts use-local with the conflict revision guard', async ({ page }) => {
  const api = await installConflictApiMocks(page);

  await page.goto(`${webUrl}/local#token=local-token`);

  const drawer = page.getByTestId('conflict-review-drawer');
  await drawer.getByLabel('Type USE LOCAL to confirm').fill('USE LOCAL');
  await drawer.getByRole('button', { name: 'Use my local version' }).click();

  expect(api.useLocalPayload()).toEqual({
    expectedSharedRevision: conflict.sharedRevision,
    expectedSharedHash: conflict.sharedHash,
  });
  expect(api.useLocalCalls()).toBe(1);
});
