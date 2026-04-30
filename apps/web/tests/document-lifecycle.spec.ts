import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  rejectManagedUrlOverrides,
  requireLocalHttpUrl,
  requireLocalWebsocketUrl,
  setupRemoteApi,
} from './setup-remote-api';

const allowExistingApi = process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true';
const webUrl = allowExistingApi ? process.env.MARKLAB_E2E_WEB_URL ?? 'http://127.0.0.1:5175' : 'http://127.0.0.1:5175';

function requireRemoteApiReadiness() {
  rejectManagedUrlOverrides();

  if (allowExistingApi) {
    requireLocalHttpUrl(webUrl, 'MARKLAB_E2E_WEB_URL');
    if (process.env.MARKLAB_E2E_API_URL) requireLocalHttpUrl(process.env.MARKLAB_E2E_API_URL, 'MARKLAB_E2E_API_URL');
    if (process.env.MARKLAB_E2E_WS_URL) requireLocalWebsocketUrl(process.env.MARKLAB_E2E_WS_URL, 'MARKLAB_E2E_WS_URL');
    return;
  }

  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for document lifecycle browser tests');
}

function extractDocumentIds(url: string): { docId: string; branchId: string } {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/docs\/([^/]+)\/branches\/([^/]+)$/u);
  if (!match) throw new Error(`expected document route, got ${parsed.pathname}`);
  const [, docId, branchId] = match;
  if (!docId || !branchId) throw new Error(`expected document ids, got ${parsed.pathname}`);

  return {
    docId: decodeURIComponent(docId),
    branchId: decodeURIComponent(branchId),
  };
}

async function expectRecentDocument(page: Page, title: string, branchId: string) {
  const recentDocuments = page.getByRole('region', { name: 'Recent documents' });
  await expect(recentDocuments).toContainText(title);
  await expect(recentDocuments).toContainText(branchId);
}

test('creates imports opens and exports cloud Markdown documents', async ({ page }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  await page.goto(webUrl);

  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MarkLab' })).toBeVisible();

  await page.getByLabel('Document title').fill('Lifecycle Blank');
  await page.getByRole('button', { name: 'New Markdown Doc' }).click();
  await expect(page).toHaveURL(/\/docs\/[^/]+\/branches\/[^/]+$/u);
  const blankDocument = extractDocumentIds(page.url());

  await page.goto(webUrl);
  await expectRecentDocument(page, 'Lifecycle Blank', blankDocument.branchId);

  await page.getByLabel('Document title').fill('Lifecycle Import');
  await page.getByLabel('Import Markdown').setInputFiles({
    name: 'lifecycle-import.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Imported Lifecycle\n\nImported body from fixture.\n'),
  });

  await expect(page).toHaveURL(/\/docs\/[^/]+\/branches\/[^/]+$/u);
  const importedDocument = extractDocumentIds(page.url());
  const importedEditor = page.getByTestId('milkdown-editor').locator('.ProseMirror');
  await expect(importedEditor).toContainText('Imported Lifecycle');
  await expect(importedEditor).toContainText('Imported body from fixture.');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Markdown' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^lifecycle-import__EXPORT__doc-[a-z0-9]+__branch-main__v\d{4}__\d{8}-\d{6}Z__sha-[a-f0-9]{8}__check-cloud-before-use\.md$/u,
  );
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('download path unavailable');
  const exportedMarkdown = await readFile(downloadPath, 'utf8');
  expect(exportedMarkdown).toContain('# Imported Lifecycle');
  expect(exportedMarkdown).toContain('Imported body from fixture.');

  await page.goto(webUrl);
  await expectRecentDocument(page, 'Lifecycle Import', importedDocument.branchId);

  await page.evaluate(() => localStorage.clear());
  await page.goto(
    `${webUrl}/docs/${encodeURIComponent(importedDocument.docId)}/branches/${encodeURIComponent(importedDocument.branchId)}`,
  );
  await expect(page.getByTestId('remote-document-id')).toHaveText(importedDocument.docId);
  await page.goto(webUrl);
  await expectRecentDocument(page, importedDocument.docId, importedDocument.branchId);

  await page.goto(webUrl);
  await page.getByLabel('Document id').fill(blankDocument.docId);
  await page.getByLabel('Branch id').fill(blankDocument.branchId);
  await page.getByRole('button', { name: 'Open' }).click();

  await expect(page).toHaveURL(
    `/docs/${encodeURIComponent(blankDocument.docId)}/branches/${encodeURIComponent(blankDocument.branchId)}`,
  );
  await expect(page.getByTestId('remote-document-id')).toHaveText(blankDocument.docId);
  await page.goto(webUrl);
  await expectRecentDocument(page, blankDocument.docId, blankDocument.branchId);
  expect(importedDocument.docId).not.toEqual(blankDocument.docId);
});
