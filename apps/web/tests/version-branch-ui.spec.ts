import { expect, test } from '@playwright/test';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import {
  rejectManagedUrlOverrides,
  requireLocalHttpUrl,
  requireLocalWebsocketUrl,
  setupRemoteApi,
} from './setup-remote-api';

const allowExistingApi = process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true';
const webUrl = allowExistingApi ? process.env.MARKLAB_E2E_WEB_URL ?? 'http://127.0.0.1:5175' : 'http://127.0.0.1:5175';
const apiUrl = allowExistingApi ? process.env.MARKLAB_E2E_API_URL ?? 'http://127.0.0.1:3011' : 'http://127.0.0.1:3011';

interface ImportedDocument {
  docId: string;
  branchId: string;
}

interface EditedDocument {
  versionId: string;
  hash: string;
  markdown: string;
}

function requireRemoteApiReadiness() {
  rejectManagedUrlOverrides();

  if (allowExistingApi) {
    requireLocalHttpUrl(apiUrl, 'MARKLAB_E2E_API_URL');
    requireLocalHttpUrl(webUrl, 'MARKLAB_E2E_WEB_URL');
    if (process.env.MARKLAB_E2E_WS_URL) requireLocalWebsocketUrl(process.env.MARKLAB_E2E_WS_URL, 'MARKLAB_E2E_WS_URL');
    return;
  }

  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for version branch UI tests');
}

async function expectOkResponse(response: APIResponse, action: string) {
  if (response.ok()) return;

  throw new Error(`${action} failed with ${response.status()} ${response.statusText()}: ${await response.text()}`);
}

async function importDocument(request: APIRequestContext): Promise<ImportedDocument> {
  const response = await request.post(`${apiUrl}/api/docs/import`, {
    data: {
      title: 'Version Branch UI',
      markdown: '# Version Branch UI\n\nOriginal paragraph for version one.\n',
    },
  });
  await expectOkResponse(response, 'import_doc');
  return (await response.json()) as ImportedDocument;
}

async function editDocument(request: APIRequestContext, docId: string, branchId: string): Promise<EditedDocument> {
  const response = await request.post(`${apiUrl}/api/docs/${docId}/branches/${branchId}/edit`, {
    data: {
      oldString: 'Original paragraph for version one.',
      newString: 'Edited paragraph for version two.',
      replaceAll: false,
    },
  });
  await expectOkResponse(response, 'edit_doc');
  return (await response.json()) as EditedDocument;
}

async function continueWithCollaboratorName(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Name for collaboration' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Collaborator name').fill(name);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toBeVisible();
}

test('branches from and restores older document versions', async ({ page, request }) => {
  test.skip(process.env.MARKLAB_REQUIRE_AUTH === 'true', 'Covered by the unauthenticated version UI suite; auth access is covered in access-ui.spec.ts.');

  requireRemoteApiReadiness();
  await setupRemoteApi();

  const doc = await importDocument(request);
  await editDocument(request, doc.docId, doc.branchId);

  const originalPath = `/docs/${encodeURIComponent(doc.docId)}/branches/${encodeURIComponent(doc.branchId)}`;
  await page.goto(`${webUrl}${originalPath}`);
  await continueWithCollaboratorName(page, 'Owner');

  await expect(page.getByTestId('remote-document-page')).toBeVisible();
  await expect(page.getByText('Cloud document')).toHaveCount(0);
  await page.getByRole('button', { name: 'Versions' }).click();

  const versionPanel = page.getByTestId('versions-drawer');
  await expect(versionPanel).toBeVisible();
  await expect(versionPanel.getByRole('combobox', { name: 'Branch' })).toContainText('main');
  await expect(versionPanel.getByTestId('version-row-2')).toContainText('v2');
  await expect(versionPanel.getByTestId('version-row-2')).toContainText('edit');
  await expect(versionPanel.getByTestId('version-row-1')).toContainText('v1');
  await expect(versionPanel.getByTestId('version-row-1')).toContainText('import');

  await versionPanel.getByTestId('version-row-1').click();
  await expect(versionPanel.getByTestId('version-preview')).toContainText('Original paragraph for version one.');

  await versionPanel.getByLabel('New branch name').fill('Version one branch');
  await versionPanel.getByRole('button', { name: 'Branch from this version' }).click();
  await expect(page).toHaveURL(/\/docs\/[^/]+\/branches\/(?!br_main$)[^/]+$/u);
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Original paragraph for version one.');

  await page.goto(`${webUrl}${originalPath}`);
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Edited paragraph for version two.');
  await page.getByRole('button', { name: 'Versions' }).click();
  await page.getByTestId('version-row-1').click();
  await page.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  await page.getByRole('button', { name: 'Restore this version' }).click();

  await expect(versionPanel.getByRole('status')).toHaveText('Restored version');
  await expect(page.getByTestId('version-row-3')).toContainText('rollback');
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Original paragraph for version one.');
  await expect(page).toHaveURL(`${webUrl}${originalPath}`);
});
