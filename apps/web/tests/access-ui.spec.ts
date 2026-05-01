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
  branchId: string;
  token: string;
  role: 'view' | 'edit';
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
  await expect(page.getByRole('button', { name: 'Admin settings' })).toHaveAttribute('aria-pressed', 'false');
}

async function createAccessGrant(
  request: APIRequestContext,
  doc: ImportedDocument,
  role: 'view' | 'edit',
): Promise<CreatedAccessGrant> {
  const response = await request.post(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/access-grants`, {
    headers: authHeaders(),
    data: { role },
  });
  await expectOkResponse(response, 'create_access_grant');
  return (await response.json()) as CreatedAccessGrant;
}

function accessGrantUrl(doc: ImportedDocument, grant: CreatedAccessGrant): string {
  const url = new URL(`${webUrl}${documentPath(doc)}`);
  url.searchParams.set('token', grant.token);
  url.searchParams.set('mode', grant.role);
  return url.toString();
}

async function expectCollaborationNamePrompt(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Name for collaboration' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This is how others will see your cursor.');
  await expect(page.getByTestId('milkdown-editor')).toHaveCount(0);
  return dialog;
}

function waitForAccessSession(page: Page) {
  return page.waitForResponse(
    (response) => response.url().includes('/access-sessions') && response.request().method() === 'POST',
  );
}

async function continueWithCollaboratorName(
  page: Page,
  name: string,
  options: { waitForSession?: boolean } = { waitForSession: true },
): Promise<CreatedAccessSession | null> {
  const dialog = await expectCollaborationNamePrompt(page);
  const sessionResponse = options.waitForSession ? waitForAccessSession(page) : null;
  await dialog.getByLabel('Collaborator name').fill(name);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Access UI');
  return sessionResponse ? ((await (await sessionResponse).json()) as CreatedAccessSession) : null;
}

async function continueAsGuest(page: Page): Promise<CreatedAccessSession> {
  const dialog = await expectCollaborationNamePrompt(page);
  const sessionResponse = waitForAccessSession(page);
  await dialog.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Access UI');
  return (await (await sessionResponse).json()) as CreatedAccessSession;
}

async function expectRenderedReadOnlyDocument(page: Page) {
  const readOnlyDocument = page.getByTestId('read-only-document');
  const readOnlySurface = readOnlyDocument.locator('.ProseMirror');

  await expect(readOnlyDocument).toContainText('Access UI');
  await expect(readOnlySurface).toBeVisible();
  await expect(readOnlySurface).toHaveAttribute('contenteditable', 'false');
  await expect(readOnlySurface.locator('h1')).toContainText('Access UI');
  await expect(readOnlySurface).not.toContainText('# Access UI');
  await expect(readOnlyDocument.locator('pre')).toHaveCount(0);

  const selectedText = await readOnlySurface.locator('h1').evaluate((heading) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(heading);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? '';
  });
  expect(selectedText).toContain('Access');

  await readOnlySurface.click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Read-only edit attempt.');
  await expect(readOnlySurface).not.toContainText('Read-only edit attempt.');
}

test('edit access links prompt for collaborator names and create browser sessions', async ({ browser, request }) => {
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
  const editGrant = await createAccessGrant(request, doc, 'edit');
  const editUrl = accessGrantUrl(doc, editGrant);
  expect(editUrl).toContain(`${webUrl}${documentPath(doc)}`);
  expect(editUrl).toContain('token=ml_access_');

  let namedContext: BrowserContext | undefined;
  let editContext: BrowserContext | undefined;
  try {
    namedContext = await browser.newContext();
    editContext = await browser.newContext();
    const namedPage = await namedContext.newPage();
    const sharedPage = await editContext.newPage();

    await namedPage.goto(editUrl);
    await expect(await continueWithCollaboratorName(namedPage, 'Alex')).toMatchObject({
      displayName: 'Alex',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/iu),
    });

    await sharedPage.goto(editUrl);
    await expect(await continueAsGuest(sharedPage)).toMatchObject({
      displayName: 'Guest 1',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/iu),
    });

    const sharedEditor = sharedPage.getByTestId('milkdown-editor').locator('.ProseMirror');
    const namedEditor = namedPage.getByTestId('milkdown-editor').locator('.ProseMirror');
    await expect(sharedEditor).toContainText('Access UI');

    await namedEditor.click();
    await namedPage.keyboard.press('ArrowRight');
    await expect(sharedPage.locator('.marklab-collab-cursor-label')).toContainText('Alex');
  } finally {
    await namedContext?.close();
    await editContext?.close();
  }
});

test('blank edit access names become numbered guests and reopen without prompting', async ({ browser, request }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  const doc = await importDocument(request);
  const editGrant = await createAccessGrant(request, doc, 'edit');
  const editUrl = accessGrantUrl(doc, editGrant);

  let firstContext: BrowserContext | undefined;
  let secondContext: BrowserContext | undefined;
  try {
    firstContext = await browser.newContext();
    secondContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    await firstPage.goto(editUrl);
    await expect(await continueAsGuest(firstPage)).toMatchObject({ displayName: 'Guest 1' });

    const repeatSessionResponse = waitForAccessSession(firstPage);
    await firstPage.goto(editUrl);
    await expect(firstPage.getByRole('dialog', { name: 'Name for collaboration' })).toHaveCount(0);
    await expect(firstPage.getByTestId('milkdown-editor').locator('.ProseMirror')).toContainText('Access UI');
    await expect((await (await repeatSessionResponse).json()) as CreatedAccessSession).toMatchObject({
      displayName: 'Guest 1',
    });

    await secondPage.goto(editUrl);
    await expect(await continueAsGuest(secondPage)).toMatchObject({ displayName: 'Guest 2' });
  } finally {
    await firstContext?.close();
    await secondContext?.close();
  }
});

test('owner editing prompts for a local collaborator name when none is stored', async ({ page, request }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  const doc = await importDocument(request);
  await saveAdminToken(page);
  await page.goto(`${webUrl}${documentPath(doc)}`);
  await continueWithCollaboratorName(page, 'Owner Admin', { waitForSession: false });
});

test('view access links open read-only without collaborator sessions', async ({ browser, request }) => {
  requireRemoteApiReadiness();
  await setupRemoteApi();

  const doc = await importDocument(request);
  const viewGrant = await createAccessGrant(request, doc, 'view');
  const viewUrl = accessGrantUrl(doc, viewGrant);
  let viewContext: BrowserContext | undefined;
  try {
    viewContext = await browser.newContext();
    const viewPage = await viewContext.newPage();
    const sessionRequests: string[] = [];
    viewPage.on('request', (browserRequest) => {
      if (browserRequest.url().includes('/access-sessions')) sessionRequests.push(browserRequest.url());
    });
    await viewPage.goto(viewUrl);
    await expect(viewPage.getByRole('dialog', { name: 'Name for collaboration' })).toHaveCount(0);
    await expectRenderedReadOnlyDocument(viewPage);
    await expect(viewPage.getByTestId('milkdown-editor')).toHaveCount(0);
    await expect(viewPage.getByTestId('document-action-rail')).toHaveCount(0);
    await expect(viewPage.getByTestId('share-access-panel')).toHaveCount(0);
    await expect(viewPage.getByRole('button', { name: 'Branch from this version' })).toHaveCount(0);
    await expect(viewPage.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
    expect(sessionRequests).toEqual([]);
  } finally {
    await viewContext?.close();
  }

  const readResult = await readDocument(request, doc, viewGrant.token);
  expect(readResult.markdown).toContain('Access UI');
  await expectStatus(await writeDocument(request, doc, viewGrant.token, `${readResult.markdown}\nForbidden write.\n`), 403, 'read-only write_doc');

  expect(viewGrant.grantId).toBeTruthy();
});
