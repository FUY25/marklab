// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictReviewDrawer } from './ConflictReviewDrawer';
import type { MarklabWebApi, ReconnectConflict } from '../lib/api-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conflict: ReconnectConflict = {
  conflictId: 'conflict_1',
  relayRoomId: 'relay_1',
  localDocId: 'local_doc_1',
  localPath: '/tmp/note.md',
  baseMarkdown: '# Base\n',
  baseYjsStateBase64: null,
  baseHash: 'sha256:base',
  lastProjectedMarkdown: '# Base\n',
  lastProjectedHash: 'sha256:base',
  localMarkdown: '# Local\n',
  localYjsStateBase64: 'local',
  localHash: 'sha256:local',
  sharedMarkdown: '# Shared\n',
  sharedYjsStateBase64: 'shared',
  sharedHash: 'sha256:shared',
  sharedStateFingerprint: 'sha256:fingerprint',
  sharedRevision: 7,
  createdAt: '2026-05-15T12:00:00.000Z',
  updatedAt: '2026-05-15T12:00:00.000Z',
  status: 'open',
};

describe('ConflictReviewDrawer', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  it('requires resolved Markdown preview and explicit confirmation before applying a pasted resolution', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const resolveLocalConflict = vi.fn(async () => ({
      conflictId: 'conflict_1',
      status: 'resolved' as const,
      hash: 'sha256:empty',
      sharedRevision: 8,
    }));

    await act(async () => {
      root?.render(
        <ConflictReviewDrawer
          api={{ resolveLocalConflict } as unknown as MarklabWebApi}
          conflict={conflict}
          open
          onClose={() => undefined}
          onResolved={() => undefined}
          onStatusChange={() => undefined}
        />,
      );
    });

    const applyButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Apply resolved Markdown') as HTMLButtonElement | undefined;
    expect(applyButton).toBeTruthy();
    expect(applyButton?.disabled).toBe(true);

    const textarea = container.querySelector('#conflict-resolved-markdown') as HTMLTextAreaElement | null;
    const confirmationInput = container.querySelector('#conflict-resolved-confirmation') as HTMLInputElement | null;
    if (!textarea || !confirmationInput) throw new Error('missing_resolved_controls');

    await act(async () => {
      const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setTextareaValue?.call(textarea, '# Final\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const preview = container.querySelector('[aria-label="Resolved Markdown preview"]');
    expect(preview?.textContent).toContain('# Final');
    expect(applyButton?.disabled).toBe(true);

    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setInputValue?.call(confirmationInput, 'APPLY RESOLVED');
      confirmationInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(applyButton?.disabled).toBe(false);

    await act(async () => {
      applyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(resolveLocalConflict).toHaveBeenCalledWith('conflict_1', {
      markdown: '# Final\n',
      expectedSharedRevision: 7,
      expectedSharedHash: 'sha256:shared',
    });
  });

  it('renders an explicit diff preview before resolution choices', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ConflictReviewDrawer
          api={{} as MarklabWebApi}
          conflict={conflict}
          open
          onClose={() => undefined}
          onResolved={() => undefined}
          onStatusChange={() => undefined}
        />,
      );
    });

    const diff = container.querySelector('[aria-label="Conflict diff"]');
    const choices = container.querySelector('[aria-label="Resolution choices"]');
    expect(diff?.textContent).toContain('- # Local');
    expect(diff?.textContent).toContain('+ # Shared');
    expect(diff?.compareDocumentPosition(choices!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('clears stale confirmations when the same conflict id updates', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const api = {
      useSharedLocalConflict: vi.fn(),
      useLocalLocalConflict: vi.fn(),
      resolveLocalConflict: vi.fn(),
    } as unknown as MarklabWebApi;
    const props = {
      api,
      open: true,
      onClose: () => undefined,
      onResolved: () => undefined,
      onStatusChange: () => undefined,
    };

    await act(async () => {
      root?.render(<ConflictReviewDrawer {...props} conflict={conflict} />);
    });

    const localInput = container.querySelector('#conflict-use-local-confirmation') as HTMLInputElement | null;
    const localButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Use my local version') as HTMLButtonElement | undefined;
    if (!localInput || !localButton) throw new Error('missing_local_controls');

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(localInput, 'USE LOCAL');
      localInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const enabledLocalButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Use my local version') as HTMLButtonElement | undefined;
    expect(enabledLocalButton?.disabled).toBe(false);

    await act(async () => {
      root?.render(<ConflictReviewDrawer
        {...props}
        conflict={{
          ...conflict,
          localMarkdown: '# Local changed again\n',
          localHash: 'sha256:local-changed',
          sharedRevision: 8,
          updatedAt: '2026-05-15T12:01:00.000Z',
        }}
      />);
    });

    const updatedLocalButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Use my local version') as HTMLButtonElement | undefined;
    expect(updatedLocalButton?.disabled).toBe(true);
  });
});
