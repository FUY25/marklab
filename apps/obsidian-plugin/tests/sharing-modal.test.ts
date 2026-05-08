import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkLabPlugin from '../src/main';
import { MarkLabSharingModal } from '../src/sharing-modal';
import {
  collectText,
  createMockApp,
  findElementByText,
  findElementsByTag,
  openedModals,
  notices,
  type FakeElement,
  type MockCommand,
  type MockRibbonIcon,
} from './obsidian-mock';
import type { MarkLabLinkRole, MarkLabStatusEntry } from '../src/cli-adapter';

type DropdownLike = {
  triggerChange(value: string): void;
};

type TestPlugin = MarkLabPlugin & {
  commands: MockCommand[];
  ribbonIcons: MockRibbonIcon[];
};

function dropdownFor(selectEl: FakeElement): DropdownLike {
  return Reflect.get(selectEl, 'component') as DropdownLike;
}

function runningStatus(filePath: string): MarkLabStatusEntry {
  return {
    path: filePath,
    displayName: filePath.split('/').pop() ?? filePath,
    daemon: 'running',
    mode: 'local',
    syncState: 'synced',
    browserUrl: null,
    pid: 123,
    port: 3011,
    lastSyncAt: null,
    hasConflict: false,
    relayRoomId: null,
  };
}

function missingStatus(filePath: string): MarkLabStatusEntry {
  return {
    path: filePath,
    displayName: filePath.split('/').pop() ?? filePath,
    daemon: 'missing',
    mode: 'local',
    syncState: 'error',
    browserUrl: null,
    pid: null,
    port: null,
    lastSyncAt: null,
    hasConflict: false,
    relayRoomId: null,
  };
}

function createPlugin(app: unknown): TestPlugin {
  return new MarkLabPlugin(app as never, {
    id: 'marklab',
    name: 'MarkLab',
    version: '0.1.0',
    minAppVersion: '1.5.0',
  } as never) as TestPlugin;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  openedModals.length = 0;
  notices.length = 0;
});

describe('MarkLab sharing surface', () => {
  it('registers a ribbon entry and command for the sharing panel', async () => {
    const plugin = createPlugin(createMockApp({ path: 'Active.md', extension: 'md' }));

    await plugin.onload();

    expect(plugin.ribbonIcons).toHaveLength(1);
    expect(plugin.ribbonIcons[0]).toMatchObject({
      icon: 'share-2',
      title: 'MarkLab sharing',
    });
    expect(plugin.commands.map((command) => command.id)).toContain('open-sharing-panel');
  });

  it('opens a sharing panel that lists active and selectable Markdown pages', async () => {
    const active = { path: 'Active.md', extension: 'md' };
    const plugin = createPlugin(createMockApp(active, [active, { path: 'Folder/Other.md', extension: 'md' }]));
    await plugin.onload();

    plugin.ribbonIcons[0]?.callback();

    const modal = openedModals.at(-1);
    expect(modal).toBeInstanceOf(MarkLabSharingModal);
    const text = collectText((modal as unknown as MarkLabSharingModal).contentEl as unknown as FakeElement);
    expect(text).toContain('MarkLab sharing');
    expect(text).toContain('Active.md (active)');
    expect(text).toContain('Folder/Other.md');
  });

  it('creates a single-page link for the selected Markdown file', async () => {
    const active = { path: 'Active.md', extension: 'md' };
    const plugin = createPlugin(createMockApp(active, [active, { path: 'Folder/Other.md', extension: 'md' }]));
    const createdLinks: Array<{ filePath: string; role: MarkLabLinkRole }> = [];
    await plugin.onload();
    plugin.settings.copyCreatedLinksAutomatically = false;
    Reflect.set(plugin, 'cli', {
      checkSetup: vi.fn(async () => ({ available: true, command: 'marklab', message: 'ok' })),
      status: vi.fn(async (filePath: string) => ({ ok: true, files: [runningStatus(filePath)] })),
      createLink: vi.fn(async (filePath: string, role: MarkLabLinkRole) => {
        createdLinks.push({ filePath, role });
        return {
          ok: true,
          path: filePath,
          role,
          grantId: 'grant_1',
          relayRoomId: 'room_1',
          url: 'https://marklab.example/relay/room_1?token=abc',
          expiresAt: null,
          createdAt: null,
        };
      }),
      openBackground: vi.fn(async () => undefined),
    });

    plugin.ribbonIcons[0]?.callback();
    let modal = openedModals.at(-1) as unknown as MarkLabSharingModal;
    let selects = findElementsByTag(modal.contentEl as unknown as FakeElement, 'select');
    dropdownFor(selects[1] as FakeElement).triggerChange('/vault/Folder/Other.md');
    modal = openedModals.at(-1) as unknown as MarkLabSharingModal;
    selects = findElementsByTag(modal.contentEl as unknown as FakeElement, 'select');
    dropdownFor(selects[2] as FakeElement).triggerChange('edit');

    modal = openedModals.at(-1) as unknown as MarkLabSharingModal;
    const createButton = findElementByText(modal.contentEl as unknown as FakeElement, 'Create edit link');
    expect(createButton).not.toBeNull();
    createButton?.click();
    await flushPromises();

    expect(createdLinks).toEqual([{ filePath: '/vault/Folder/Other.md', role: 'edit' }]);
  });

  it('creates a multi-page link set for selected Markdown files', async () => {
    const createLinkSet = vi.fn(async () => true);
    const modal = new MarkLabSharingModal(createMockApp() as never, {
      defaultRole: 'view',
      markdownFiles: [
        { label: 'Active.md', filePath: '/vault/Active.md', isActive: true },
        { label: 'Folder/Other.md', filePath: '/vault/Folder/Other.md', isActive: false },
      ],
      createSinglePageLink: vi.fn(async () => true),
      createLinkSet,
    });
    modal.open();

    const [scopeSelect] = findElementsByTag(modal.contentEl as unknown as FakeElement, 'select');
    dropdownFor(scopeSelect as FakeElement).triggerChange('multiple');

    const selectAllButton = findElementByText(modal.contentEl as unknown as FakeElement, 'Select all');
    selectAllButton?.click();
    const createButton = findElementByText(modal.contentEl as unknown as FakeElement, 'Create view links (2)');
    expect(createButton).not.toBeNull();
    createButton?.click();
    await flushPromises();

    expect(createLinkSet).toHaveBeenCalledWith(
      [
        { label: 'Active.md', filePath: '/vault/Active.md', isActive: true },
        { label: 'Folder/Other.md', filePath: '/vault/Folder/Other.md', isActive: false },
      ],
      'view',
      'multiple',
    );
  });

  it('creates a vault Markdown link set with quiet background hosting after confirmation', async () => {
    const active = { path: 'Active.md', extension: 'md' };
    const plugin = createPlugin(
      createMockApp(active, [
        active,
        { path: 'Folder/Other.md', extension: 'md' },
        { path: 'image.png', extension: 'png' },
      ]),
    );
    const openBackground = vi.fn(async () => undefined);
    const createLink = vi.fn(async (filePath: string, role: MarkLabLinkRole) => ({
      ok: true,
      path: filePath,
      role,
      grantId: `grant_${filePath}`,
      relayRoomId: `room_${filePath}`,
      url: `https://marklab.example/relay/${encodeURIComponent(filePath)}?token=abc`,
      expiresAt: null,
      createdAt: null,
    }));

    await plugin.onload();
    plugin.settings.copyCreatedLinksAutomatically = false;
    Reflect.set(plugin, 'cli', {
      checkSetup: vi.fn(async () => ({ available: true, command: 'marklab', message: 'ok' })),
      status: vi.fn(async (filePath: string) => ({ ok: true, files: [missingStatus(filePath)] })),
      createLink,
      openBackground,
    });

    plugin.ribbonIcons[0]?.callback();
    let modal = openedModals.at(-1) as unknown as MarkLabSharingModal;
    const [scopeSelect] = findElementsByTag(modal.contentEl as unknown as FakeElement, 'select');
    dropdownFor(scopeSelect as FakeElement).triggerChange('vault');

    modal = openedModals.at(-1) as unknown as MarkLabSharingModal;
    const createButton = findElementByText(modal.contentEl as unknown as FakeElement, 'Create view links (2)');
    createButton?.click();
    await flushPromises();

    const confirmModal = openedModals.at(-1);
    expect(collectText(confirmModal?.contentEl as unknown as FakeElement)).toContain('Share vault Markdown?');
    findElementByText(confirmModal?.contentEl as unknown as FakeElement, 'Create links')?.click();
    await flushPromises();
    await flushPromises();

    expect(openBackground).toHaveBeenCalledWith('/vault/Active.md', { openBrowser: false });
    expect(openBackground).toHaveBeenCalledWith('/vault/Folder/Other.md', { openBrowser: false });
    expect(createLink).toHaveBeenCalledWith('/vault/Active.md', 'view');
    expect(createLink).toHaveBeenCalledWith('/vault/Folder/Other.md', 'view');
    expect(collectText(openedModals.at(-1)?.contentEl as unknown as FakeElement)).toContain('MarkLab view link set');
    expect(collectText(openedModals.at(-1)?.contentEl as unknown as FakeElement)).not.toContain('image.png');
  });
});
