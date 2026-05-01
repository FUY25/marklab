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
const adminToken = process.env.MARKLAB_E2E_ADMIN_TOKEN ?? 'marklab-e2e-admin-token';

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

async function saveAdminToken(page: Page) {
  await page.getByLabel('Admin token').fill(adminToken);
  await page.getByRole('button', { name: 'Save admin token' }).click();
  await expect(page.getByRole('status')).toContainText('Admin token saved for this browser session.');
}

async function continueWithCollaboratorName(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Name for collaboration' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Collaborator name').fill(name);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toBeVisible();
}

async function expectRecentDocument(page: Page, title: string, branchId: string) {
  const recentDocuments = page.getByRole('region', { name: 'Recent documents' });
  await expect(recentDocuments).toContainText(title);
  await expect(recentDocuments).toContainText(branchId);
}

test('creates imports opens and exports cloud Markdown documents', async ({ page }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();
  const forbiddenResponses: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 403) forbiddenResponses.push(response.url());
  });

  await page.goto(webUrl);
  await saveAdminToken(page);

  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MarkLab' })).toBeVisible();

  await page.getByLabel('Document title').fill('Lifecycle Blank');
  await page.getByRole('button', { name: 'New Markdown Doc' }).click();
  await expect(page).toHaveURL(/\/docs\/[^/]+\/branches\/[^/]+$/u);
  const blankDocument = extractDocumentIds(page.url());
  await continueWithCollaboratorName(page, 'Owner');

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
  await continueWithCollaboratorName(page, 'Owner');
  const importedEditor = page.getByTestId('milkdown-editor').locator('.ProseMirror');
  await expect(importedEditor).toContainText('Imported Lifecycle');
  await expect(importedEditor).toContainText('Imported body from fixture.');
  await expect(page.getByText('Cloud document')).toHaveCount(0);
  await expect(page.getByTestId('document-action-rail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Versions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  await expect(page.getByTestId('version-history-panel')).toHaveCount(0);
  await expect(page.getByTestId('share-access-panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Versions' }).click();
  const versionPanel = page.getByTestId('versions-drawer');
  await expect(versionPanel.getByRole('combobox', { name: 'Branch' })).toContainText('main');
  await expect(versionPanel.getByTestId('version-row-1')).toContainText('import');
  await expect(versionPanel.getByTestId('version-preview')).toContainText('Imported Lifecycle');
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.getByTestId('versions-drawer')).toHaveCount(0);
  await expect(page.getByTestId('share-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('share-drawer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Versions' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('versions-drawer')).toHaveCount(0);
  const autosavePromise = page.waitForResponse(
    (response) => response.url().includes('/versions/autosave') && response.request().method() === 'POST',
  );
  await importedEditor.click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+End`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Admin owner edit.');
  await expect(importedEditor).toContainText('Admin owner edit.');
  await autosavePromise;
  await expect(page.getByText('Connection lost')).toHaveCount(0);
  await expect(page.getByText(/request_failed:403/u)).toHaveCount(0);
  expect(forbiddenResponses).toEqual([]);

  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/versions/manual-save') && response.request().method() === 'POST'),
    page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+S`),
  ]);
  await expect(page.getByText(/Manual saved v\d+|No changes to save/u).first()).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Versions' }).click();
  await page.getByTestId('versions-drawer').getByRole('button', { name: 'Export .md' }).click();
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

  await page.getByLabel('Document id').fill(importedDocument.docId);
  await page.getByLabel('Branch id').fill(importedDocument.branchId);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(
    `/docs/${encodeURIComponent(importedDocument.docId)}/branches/${encodeURIComponent(importedDocument.branchId)}`,
  );
  await page.goto(webUrl);
  await expectRecentDocument(page, 'Lifecycle Import', importedDocument.branchId);

  await page.evaluate(() => localStorage.clear());
  await page.goto(
    `${webUrl}/docs/${encodeURIComponent(importedDocument.docId)}/branches/${encodeURIComponent(importedDocument.branchId)}`,
  );
  await continueWithCollaboratorName(page, 'Owner');
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Imported Lifecycle');
  await page.goto(webUrl);
  await expectRecentDocument(page, 'Lifecycle Import', importedDocument.branchId);

  await page.goto(webUrl);
  await page.getByLabel('Document id').fill(blankDocument.docId);
  await page.getByLabel('Branch id').fill(blankDocument.branchId);
  await page.getByRole('button', { name: 'Open' }).click();

  await expect(page).toHaveURL(
    `/docs/${encodeURIComponent(blankDocument.docId)}/branches/${encodeURIComponent(blankDocument.branchId)}`,
  );
  await continueWithCollaboratorName(page, 'Owner');
  await expect(page.getByTestId('milkdown-editor')).toBeVisible();
  await page.goto(webUrl);
  await expectRecentDocument(page, 'Lifecycle Blank', blankDocument.branchId);
  expect(importedDocument.docId).not.toEqual(blankDocument.docId);
});
