import { expect, test } from '@playwright/test';
import type { BrowserContext, APIRequestContext } from '@playwright/test';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const webUrl = process.env.MARKLAB_E2E_WEB_URL ?? 'http://127.0.0.1:5175';
const apiUrl = process.env.MARKLAB_E2E_API_URL ?? 'http://127.0.0.1:3001';

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
  if (process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true') return;
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for remote document browser tests');
}

async function importDocument(request: APIRequestContext): Promise<ImportedDocument> {
  const response = await request.post(`${apiUrl}/api/docs/import`, {
    data: {
      title: 'Remote E2E',
      markdown: '# Remote E2E\n\nOriginal paragraph.\n',
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ImportedDocument;
}

async function readDocument(
  request: APIRequestContext,
  docId: string,
  branchId: string,
): Promise<ReadDocument> {
  const response = await request.get(`${apiUrl}/api/docs/${docId}/branches/${branchId}/read`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ReadDocument;
}

test('keeps two remote browser windows and API writes synchronized without refresh', async ({ browser, request }) => {
  requireRemoteApiReadiness();

  const doc = await importDocument(request);
  const documentPath = `/docs/${encodeURIComponent(doc.docId)}/branches/${encodeURIComponent(doc.branchId)}`;

  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;

  try {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await Promise.all([pageA.goto(`${webUrl}${documentPath}`), pageB.goto(`${webUrl}${documentPath}`)]);

    await expect(pageA.getByTestId('remote-document-page')).toBeVisible();
    await expect(pageB.getByTestId('remote-document-page')).toBeVisible();
    await expect(pageA.getByTestId('remote-document-id')).toHaveText(doc.docId);
    await expect(pageB.getByTestId('remote-document-id')).toHaveText(doc.docId);

    const editorA = pageA.getByTestId('milkdown-editor').locator('.ProseMirror');
    const editorB = pageB.getByTestId('milkdown-editor').locator('.ProseMirror');

    await expect(editorA).toContainText('Remote E2E');
    await expect(editorB).toContainText('Remote E2E');

    await editorA.click();
    await pageA.keyboard.press(`${modifier}+End`);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type('Browser A edit.');
    await expect(editorB).toContainText('Browser A edit.');

    const current = await readDocument(request, doc.docId, doc.branchId);
    const writeResponse = await request.post(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/write`, {
      data: {
        baseVersionId: current.versionId,
        baseHash: current.hash,
        markdown: `${current.markdown.trimEnd()}\n\nAPI write visible.\n`,
      },
    });
    expect(writeResponse.ok()).toBeTruthy();

    await expect(editorA).toContainText('API write visible.');
    await expect(editorB).toContainText('API write visible.');
  } finally {
    await contextA?.close();
    await contextB?.close();
  }
});
