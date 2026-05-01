import { expect, test } from '@playwright/test';
import type { APIRequestContext, APIResponse, BrowserContext } from '@playwright/test';
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

interface CreatedShareLink {
  token: string;
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

async function createEditShareToken(request: APIRequestContext, docId: string, branchId: string): Promise<string> {
  const response = await request.post(`${apiUrl}/api/docs/${docId}/branches/${branchId}/share-links`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { role: 'edit' },
  });
  await expectOkResponse(response, 'create_share_link');
  return ((await response.json()) as CreatedShareLink).token;
}

test('keeps two remote browser windows and API writes synchronized without refresh', async ({ browser, request }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  const doc = await importDocument(request);
  const editToken = await createEditShareToken(request, doc.docId, doc.branchId);
  const documentPath = `/docs/${encodeURIComponent(doc.docId)}/branches/${encodeURIComponent(doc.branchId)}`;
  const editDocumentUrl = `${webUrl}${documentPath}?token=${encodeURIComponent(editToken)}&mode=edit`;

  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;

  try {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await Promise.all([pageA.goto(editDocumentUrl), pageB.goto(editDocumentUrl)]);

    await expect(pageA.getByTestId('remote-document-page')).toBeVisible();
    await expect(pageB.getByTestId('remote-document-page')).toBeVisible();
    await expect(pageA.getByTestId('remote-document-id')).toHaveText(doc.docId);
    await expect(pageB.getByTestId('remote-document-id')).toHaveText(doc.docId);

    const editorA = pageA.getByTestId('milkdown-editor').locator('.ProseMirror');
    const editorB = pageB.getByTestId('milkdown-editor').locator('.ProseMirror');

    await expect(editorA).toContainText('Remote E2E');
    await expect(editorB).toContainText('Remote E2E');

    await editorA.click();
    await expect(pageB.locator('.ProseMirror-yjs-cursor')).toHaveCount(1);
    await expect(pageB.locator('.ProseMirror-yjs-cursor div')).toHaveCount(0);
    await expect(pageB.locator('.ProseMirror-yjs-cursor')).not.toContainText('Human Writer');
    const pageACursorColor = await pageB.locator('.ProseMirror-yjs-cursor').evaluate((element) => getComputedStyle(element).borderColor);

    await editorB.click();
    await expect(pageA.locator('.ProseMirror-yjs-cursor')).toHaveCount(1);
    const pageBCursorColor = await pageA.locator('.ProseMirror-yjs-cursor').evaluate((element) => getComputedStyle(element).borderColor);
    expect(pageBCursorColor).not.toBe(pageACursorColor);

    await editorA.click();
    await pageA.keyboard.press(`${modifier}+End`);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type('Browser A edit.');
    await expect(editorB).toContainText('Browser A edit.');

    const current = await readDocument(request, doc.docId, doc.branchId, editToken);
    expect(current.markdown).toContain('Browser A edit.');
    const writeResponse = await request.post(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/write`, {
      headers: { Authorization: `Bearer ${editToken}` },
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
