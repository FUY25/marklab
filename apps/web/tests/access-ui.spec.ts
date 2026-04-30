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

function requireRemoteApiReadiness() {
  rejectManagedUrlOverrides();

  if (allowExistingApi) {
    requireLocalHttpUrl(apiUrl, 'MARKLAB_E2E_API_URL');
    requireLocalHttpUrl(webUrl, 'MARKLAB_E2E_WEB_URL');
    if (process.env.MARKLAB_E2E_WS_URL) requireLocalWebsocketUrl(process.env.MARKLAB_E2E_WS_URL, 'MARKLAB_E2E_WS_URL');
    return;
  }

  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for access browser tests');
}

function documentPath(doc: ImportedDocument): string {
  return `/docs/${encodeURIComponent(doc.docId)}/branches/${encodeURIComponent(doc.branchId)}`;
}

async function expectStatus(response: APIResponse, status: number, action: string) {
  if (response.status() === status) return;
  throw new Error(`${action} expected ${status}, got ${response.status()} ${response.statusText()}: ${await response.text()}`);
}

async function expectOkResponse(response: APIResponse, action: string) {
  if (response.ok()) return;
  throw new Error(`${action} failed with ${response.status()} ${response.statusText()}: ${await response.text()}`);
}

function authHeaders(token: string = adminToken) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function importDocument(request: APIRequestContext): Promise<ImportedDocument> {
  const response = await request.post(`${apiUrl}/api/docs/import`, {
    headers: authHeaders(),
    data: {
      title: 'Access UI',
      markdown: '# Access UI\n\nOriginal paragraph.\n',
    },
  });
  await expectOkResponse(response, 'import_doc');
  return (await response.json()) as ImportedDocument;
}

async function readDocument(request: APIRequestContext, doc: ImportedDocument, token: string): Promise<ReadDocument> {
  const response = await request.get(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/read`, {
    headers: authHeaders(token),
  });
  await expectOkResponse(response, 'read_doc');
  return (await response.json()) as ReadDocument;
}

async function writeDocument(request: APIRequestContext, doc: ImportedDocument, token: string, markdown: string): Promise<APIResponse> {
  const current = await readDocument(request, doc, token);
  return request.post(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/write`, {
    headers: authHeaders(token),
    data: {
      baseVersionId: current.versionId,
      baseHash: current.hash,
      markdown,
    },
  });
}

async function saveAdminToken(page: Page) {
  await page.goto(webUrl);
  await page.getByLabel('Admin token').fill(adminToken);
  await page.getByRole('button', { name: 'Save admin token' }).click();
  await expect(page.getByRole('status')).toContainText('Admin token saved for this browser session.');
}

async function createShareLink(page: Page, role: 'view' | 'edit'): Promise<string> {
  await page.getByLabel('Share link role').selectOption(role);
  await page.getByRole('button', { name: 'Create share link' }).click();
  const shareUrl = page.getByTestId('created-share-url');
  await expect(shareUrl).toContainText(`mode=${role}`);
  return (await shareUrl.textContent())?.trim() ?? '';
}

async function createReadOnlyAgentToken(page: Page): Promise<string> {
  await page.getByLabel('Agent token name').fill('Read-only agent');
  await page.getByLabel('Allow writes').setChecked(false);
  await page.getByRole('button', { name: 'Create agent token' }).click();
  const rawToken = page.getByTestId('created-agent-token');
  await expect(rawToken).toContainText(/^ml_agent_/u);
  return (await rawToken.textContent())?.trim() ?? '';
}

test('manages share links and agent tokens under required auth', async ({ browser, page, request }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  await expectStatus(
    await request.post(`${apiUrl}/api/docs/import`, {
      data: { title: 'Rejected import', markdown: '# Rejected\n' },
    }),
    403,
    'unauthenticated import_doc',
  );

  const doc = await importDocument(request);
  await saveAdminToken(page);
  await page.goto(`${webUrl}${documentPath(doc)}`);
  await expect(page.getByTestId('remote-document-page')).toBeVisible();

  const editShareUrl = await createShareLink(page, 'edit');
  expect(editShareUrl).toContain(`${webUrl}${documentPath(doc)}`);
  expect(editShareUrl).toContain('token=ml_share_');
  await page.goto(editShareUrl);
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Access UI');

  let editContext: BrowserContext | undefined;
  try {
    editContext = await browser.newContext();
    const sharedPage = await editContext.newPage();
    await sharedPage.goto(editShareUrl);
    const sharedEditor = sharedPage.getByTestId('milkdown-editor').locator('.ProseMirror');
    const ownerEditor = page.getByTestId('milkdown-editor').locator('.ProseMirror');
    await expect(sharedEditor).toContainText('Access UI');

    await sharedEditor.click();
    await sharedPage.keyboard.press(`${modifier}+End`);
    await sharedPage.keyboard.press('Enter');
    await sharedPage.keyboard.type('Shared edit.');
    await expect(ownerEditor).toContainText('Shared edit.');
  } finally {
    await editContext?.close();
  }

  const viewShareUrl = await createShareLink(page, 'view');
  let viewContext: BrowserContext | undefined;
  try {
    viewContext = await browser.newContext();
    const viewPage = await viewContext.newPage();
    await viewPage.goto(viewShareUrl);
    await expect(viewPage.getByTestId('read-only-document')).toContainText('Access UI');
    await expect(viewPage.getByTestId('milkdown-editor')).toHaveCount(0);
    await expect(viewPage.locator('.ProseMirror')).toHaveCount(0);
    await expect(viewPage.getByTestId('share-access-panel')).toHaveCount(0);
    await expect(viewPage.getByRole('button', { name: 'Branch from this version' })).toHaveCount(0);
    await expect(viewPage.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
  } finally {
    await viewContext?.close();
  }

  const agentToken = await createReadOnlyAgentToken(page);
  const readResult = await readDocument(request, doc, agentToken);
  expect(readResult.markdown).toContain('Shared edit.');
  await expectStatus(await writeDocument(request, doc, agentToken, `${readResult.markdown}\nForbidden write.\n`), 403, 'read-only write_doc');

  let readOnlyAgentContext: BrowserContext | undefined;
  try {
    readOnlyAgentContext = await browser.newContext();
    const readOnlyAgentPage = await readOnlyAgentContext.newPage();
    await readOnlyAgentPage.goto(
      `${webUrl}${documentPath(doc)}?token=${encodeURIComponent(agentToken)}&mode=edit`,
    );
    await expect(readOnlyAgentPage.getByTestId('read-only-document')).toContainText('Access UI');
    await expect(readOnlyAgentPage.getByTestId('milkdown-editor')).toHaveCount(0);
    await expect(readOnlyAgentPage.locator('.ProseMirror')).toHaveCount(0);
    await expect(readOnlyAgentPage.getByTestId('share-access-panel')).toHaveCount(0);
    await expect(readOnlyAgentPage.getByRole('button', { name: 'Branch from this version' })).toHaveCount(0);
    await expect(readOnlyAgentPage.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
  } finally {
    await readOnlyAgentContext?.close();
  }

  await page.getByRole('button', { name: 'Revoke agent token Read-only agent' }).click();
  await expectStatus(
    await request.get(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/read`, {
      headers: authHeaders(agentToken),
    }),
    403,
    'revoked read_doc',
  );
});
