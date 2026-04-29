import { expect, test } from '@playwright/test';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('renders the Crepe editor shell without TopBar and keeps editing chrome', async ({ page }) => {
  await page.goto('/');

  const editor = page.getByTestId('milkdown-editor');
  await expect(editor.locator('.milkdown')).toBeVisible();
  await expect(editor.locator('.milkdown-top-bar')).toHaveCount(0);
  await expect(editor.locator('.ProseMirror')).toBeVisible();
  await expect(editor.locator('.milkdown-toolbar')).toHaveCount(1);
  await expect(editor.locator('.milkdown-block-handle')).toHaveCount(2);
});

test('shows the floating toolbar for selected prose and applies formatting', async ({ page }) => {
  await page.goto('/');

  const editor = page.getByTestId('milkdown-editor');
  const paragraph = editor.locator('.ProseMirror p').first();
  const paragraphBox = await paragraph.boundingBox();
  if (!paragraphBox) throw new Error('paragraph box unavailable');

  await page.mouse.move(paragraphBox.x + 5, paragraphBox.y + paragraphBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(paragraphBox.x + 180, paragraphBox.y + paragraphBox.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(editor.locator('.milkdown-toolbar')).toBeVisible();
  await page.keyboard.press(`${modifier}+B`);
  await expect(editor.locator('.ProseMirror strong')).toContainText('Edit this');
});

test('opens slash menu, hides image insertion, and inserts a table block', async ({ page }) => {
  await page.goto('/');

  const editor = page.getByTestId('milkdown-editor');
  await editor.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');

  const slashMenu = page.locator('.milkdown-slash-menu');
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu).toContainText('Table');
  await expect(slashMenu).toContainText('Math');
  await expect(slashMenu).not.toContainText('Image');

  await slashMenu.getByText('Table', { exact: true }).click();

  await expect(editor.locator('.milkdown-table-block')).toBeVisible();
});

test('inserts a CodeMirror-backed code block from slash commands', async ({ page }) => {
  await page.goto('/');

  const editor = page.getByTestId('milkdown-editor');
  await editor.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const slashMenu = page.locator('.milkdown-slash-menu');
  await expect(slashMenu).toContainText('Code');
  await slashMenu.getByText('Code', { exact: true }).click();

  await expect(editor.locator('.milkdown-code-block')).toBeVisible();
  await expect(editor.locator('.cm-editor')).toBeVisible();
});

test('collab undo removes only the local edit and keeps remote content', async ({ page }) => {
  await page.goto('/?collab=two');

  const leftEditor = page.getByTestId('milkdown-editor-left').locator('.ProseMirror');
  const rightEditor = page.getByTestId('milkdown-editor-right').locator('.ProseMirror');

  await expect(leftEditor).toContainText('Markdown AI Collab');
  await expect(rightEditor).toContainText('Markdown AI Collab');

  await leftEditor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('local A');
  await expect(rightEditor).toContainText('local A');

  await rightEditor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('remote B');
  await expect(leftEditor).toContainText('remote B');

  await leftEditor.click();
  await page.keyboard.press(`${modifier}+Z`);

  await expect(leftEditor).not.toContainText('local A');
  await expect(rightEditor).not.toContainText('local A');
  await expect(leftEditor).toContainText('remote B');
  await expect(rightEditor).toContainText('remote B');
});
