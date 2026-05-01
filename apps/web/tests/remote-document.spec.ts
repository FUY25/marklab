import { expect, test } from '@playwright/test';
import type { APIRequestContext, APIResponse, BrowserContext, Page } from '@playwright/test';
import {
  rejectManagedUrlOverrides,
  requireLocalHttpUrl,
  requireLocalWebsocketUrl,
  setupRemoteApi,
} from './setup-remote-api';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const allowExistingApi = process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true';
const webUrl = allowExistingApi ? process.env.MARKLAB_E2E_WEB_URL ?? 'http://127.0.0.1:5175' : 'http://127.0.0.1:5175';
const apiUrl = allowExistingApi ? process.env.MARKLAB_E2E_API_URL ?? 'http://127.0.0.1:3011' : 'http://127.0.0.1:3011';
const adminToken = process.env.MARKLAB_E2E_ADMIN_TOKEN ?? 'marklab-e2e-admin-token';

interface ImportedDocument {
  docId: string;
  branchId: string;
}

interface ReadDocument {
  versionId: string;
  hash: string;
  markdown: string;
}

interface CreatedAccessGrant {
  grantId: string;
  token: string;
}

interface CreatedAccessSession {
  displayName: string;
  color: string;
}

function requireRemoteApiReadiness() {
  rejectManagedUrlOverrides();

  if (allowExistingApi) {
    requireLocalHttpUrl(apiUrl, 'MARKLAB_E2E_API_URL');
    requireLocalHttpUrl(webUrl, 'MARKLAB_E2E_WEB_URL');
    if (process.env.MARKLAB_E2E_WS_URL) requireLocalWebsocketUrl(process.env.MARKLAB_E2E_WS_URL, 'MARKLAB_E2E_WS_URL');
    return;
  }

  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for remote document browser tests');
}

async function expectOkResponse(response: APIResponse, action: string) {
  if (response.ok()) return;

  throw new Error(`${action} failed with ${response.status()} ${response.statusText()}: ${await response.text()}`);
}

async function importDocument(request: APIRequestContext): Promise<ImportedDocument> {
  const response = await request.post(`${apiUrl}/api/docs/import`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      title: 'Remote E2E',
      markdown: '# Remote E2E\n\nOriginal paragraph.\n',
    },
  });
  await expectOkResponse(response, 'import_doc');
  return (await response.json()) as ImportedDocument;
}

async function readDocument(
  request: APIRequestContext,
  docId: string,
  branchId: string,
  token: string,
): Promise<ReadDocument> {
  const response = await request.get(`${apiUrl}/api/docs/${docId}/branches/${branchId}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOkResponse(response, 'read_doc');
  return (await response.json()) as ReadDocument;
}

async function createEditAccessGrant(request: APIRequestContext, docId: string, branchId: string): Promise<CreatedAccessGrant> {
  const response = await request.post(`${apiUrl}/api/docs/${docId}/branches/${branchId}/access-grants`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { role: 'edit' },
  });
  await expectOkResponse(response, 'create_access_grant');
  return (await response.json()) as CreatedAccessGrant;
}

async function editDocument(request: APIRequestContext, docId: string, branchId: string) {
  const response = await request.post(`${apiUrl}/api/docs/${docId}/branches/${branchId}/edit`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      oldString: 'Original paragraph.',
      newString: 'Edited paragraph.',
      replaceAll: false,
    },
  });
  await expectOkResponse(response, 'edit_doc');
}

async function joinEditableAccessLink(page: Page, accessUrl: string, displayName: string): Promise<CreatedAccessSession> {
  await page.goto(accessUrl);
  const dialog = page.getByRole('dialog', { name: 'Name for collaboration' });
  await expect(dialog).toBeVisible();
  const sessionResponse = page.waitForResponse(
    (response) => response.url().includes('/access-sessions') && response.request().method() === 'POST',
  );
  await dialog.getByLabel('Collaborator name').fill(displayName);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toBeVisible();
  return (await (await sessionResponse).json()) as CreatedAccessSession;
}

test('keeps two remote browser windows and API writes synchronized without refresh', async ({ browser, request }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  const doc = await importDocument(request);
  const editGrant = await createEditAccessGrant(request, doc.docId, doc.branchId);
  const documentPath = `/docs/${encodeURIComponent(doc.docId)}/branches/${encodeURIComponent(doc.branchId)}`;
  const editDocumentUrl = `${webUrl}${documentPath}?token=${encodeURIComponent(editGrant.token)}&mode=edit`;

  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;

  try {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const [sessionA, sessionB] = await Promise.all([
      joinEditableAccessLink(pageA, editDocumentUrl, 'Alex'),
      joinEditableAccessLink(pageB, editDocumentUrl, 'Blair'),
    ]);
    expect(sessionA).toMatchObject({ displayName: 'Alex', color: expect.stringMatching(/^#[0-9a-f]{6}$/iu) });
    expect(sessionB).toMatchObject({ displayName: 'Blair', color: expect.stringMatching(/^#[0-9a-f]{6}$/iu) });
    expect(sessionB.color).not.toBe(sessionA.color);

    await expect(pageA.getByTestId('remote-document-page')).toBeVisible();
    await expect(pageB.getByTestId('remote-document-page')).toBeVisible();
    await expect(pageA.getByTestId('document-action-rail')).toBeVisible();
    await expect(pageB.getByTestId('document-action-rail')).toBeVisible();

    const editorA = pageA.getByTestId('milkdown-editor').locator('.ProseMirror');
    const editorB = pageB.getByTestId('milkdown-editor').locator('.ProseMirror');

    await expect(editorA).toContainText('Remote E2E');
    await expect(editorB).toContainText('Remote E2E');

    await editorA.click();
    await expect(pageB.locator('.ProseMirror-yjs-cursor')).toHaveCount(1);
    await expect(pageB.locator('.marklab-collab-cursor-label')).toContainText('Alex');

    await editorB.click();
    await expect(pageA.locator('.ProseMirror-yjs-cursor')).toHaveCount(1);
    await expect(pageA.locator('.marklab-collab-cursor-label')).toContainText('Blair');

    await editorA.click();
    await pageA.keyboard.press(`${modifier}+End`);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type('Browser A edit.');
    await expect(editorB).toContainText('Browser A edit.');

    const current = await readDocument(request, doc.docId, doc.branchId, editGrant.token);
    expect(current.markdown).toContain('Browser A edit.');
    const writeResponse = await request.post(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/write`, {
      headers: { Authorization: `Bearer ${editGrant.token}` },
      data: {
        baseVersionId: current.versionId,
        baseHash: current.hash,
        markdown: `${current.markdown.trimEnd()}\n\nAPI write visible.\n`,
      },
    });
    await expectOkResponse(writeResponse, 'write_doc');

    await expect(editorA).toContainText('Browser A edit.');
    await expect(editorB).toContainText('Browser A edit.');
    await expect(editorA).toContainText('API write visible.');
    await expect(editorB).toContainText('API write visible.');
  } finally {
    await contextA?.close();
    await contextB?.close();
  }
});

test('keeps version drawer state local while restore updates the shared branch', async ({ browser, request }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  const doc = await importDocument(request);
  await editDocument(request, doc.docId, doc.branchId);
  const editGrant = await createEditAccessGrant(request, doc.docId, doc.branchId);
  const documentPath = `/docs/${encodeURIComponent(doc.docId)}/branches/${encodeURIComponent(doc.branchId)}`;
  const editDocumentUrl = `${webUrl}${documentPath}?token=${encodeURIComponent(editGrant.token)}&mode=edit`;

  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;

  try {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await Promise.all([
      joinEditableAccessLink(pageA, editDocumentUrl, 'Alex'),
      joinEditableAccessLink(pageB, editDocumentUrl, 'Blair'),
    ]);

    const editorA = pageA.getByTestId('milkdown-editor').locator('.ProseMirror');
    const editorB = pageB.getByTestId('milkdown-editor').locator('.ProseMirror');
    await expect(editorA).toContainText('Edited paragraph.');
    await expect(editorB).toContainText('Edited paragraph.');

    await pageA.getByRole('button', { name: 'Versions' }).click();
    await pageB.getByRole('button', { name: 'Versions' }).click();
    const versionPanelA = pageA.getByTestId('versions-drawer');
    const versionPanelB = pageB.getByTestId('versions-drawer');
    await expect(versionPanelA.getByTestId('version-row-2')).toContainText('v2');
    await expect(versionPanelB.getByTestId('version-row-2')).toContainText('v2');

    await pageB.keyboard.press('Escape');
    await expect(pageB.getByTestId('versions-drawer')).toHaveCount(0);
    await expect(versionPanelA.getByTestId('version-preview')).toBeVisible();

    await versionPanelA.getByTestId('version-row-1').click();
    await expect(versionPanelA.getByTestId('version-preview')).toContainText('Original paragraph.');
    await pageB.getByRole('button', { name: 'Versions' }).click();
    await expect(versionPanelB.getByTestId('version-preview')).toContainText('Edited paragraph.');

    await versionPanelA.getByLabel('Type RESTORE to confirm').fill('RESTORE');
    await Promise.all([
      pageA.waitForResponse((response) => response.url().includes('/restore') && response.request().method() === 'POST'),
      versionPanelA.getByRole('button', { name: 'Restore this version' }).click(),
    ]);

    await expect(versionPanelA.getByRole('status')).toHaveText('Restored version');
    await expect(versionPanelA.getByTestId('version-row-3')).toContainText('rollback');
    await expect(editorA).toContainText('Original paragraph.');
    await expect(editorB).toContainText('Original paragraph.');
    await expect(pageA).toHaveURL(editDocumentUrl);
  } finally {
    await contextA?.close();
    await contextB?.close();
  }
});
