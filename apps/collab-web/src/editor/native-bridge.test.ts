// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  applyNativeDiskMarkdownToText,
  createNativeMarkdownSnapshotScheduler,
  postNativeCollaborators,
  postNativeMarkdownSnapshot,
  postNativeSelectionStatus,
} from './native-bridge';

describe('native webview bridge', () => {
  afterEach(() => {
    delete window.webkit;
  });

  it('posts markdown snapshots to MarkLab.app when the WKWebView bridge exists', () => {
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { marklabNative: { postMessage } } };

    expect(postNativeMarkdownSnapshot('# Shared\n')).toBe(true);

    expect(postMessage).toHaveBeenCalledWith({ type: 'markdown-snapshot', markdown: '# Shared\n' });
  });

  it('posts selection status to MarkLab.app when the WKWebView bridge exists', () => {
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { marklabNative: { postMessage } } };

    expect(postNativeSelectionStatus('Ln 2, Col 4')).toBe(true);

    expect(postMessage).toHaveBeenCalledWith({ type: 'selection-change', status: 'Ln 2, Col 4' });
  });

  it('posts collaborator summaries to MarkLab.app when remote awareness changes', () => {
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { marklabNative: { postMessage } } };

    expect(postNativeCollaborators([{
      clientId: 42,
      name: 'Guest',
      color: '#0891b2',
      colorLight: '#cffafe',
      kind: 'human',
      clientKind: 'browser',
    }])).toBe(true);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'collaborators-change',
      collaborators: [{
        clientId: 42,
        name: 'Guest',
        color: '#0891b2',
        colorLight: '#cffafe',
        kind: 'human',
        clientKind: 'browser',
      }],
    });
  });

  it('is a no-op in normal browser sessions', () => {
    expect(postNativeMarkdownSnapshot('# Browser\n')).toBe(false);
    expect(postNativeSelectionStatus('Ln 1, Col 1')).toBe(false);
    expect(postNativeCollaborators([])).toBe(false);
  });

  it('coalesces native markdown snapshots and reads the full document on the next frame', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const readMarkdown = vi.fn(() => '# Latest\n');
    const postSnapshot = vi.fn(() => true);
    const scheduler = createNativeMarkdownSnapshotScheduler({
      readMarkdown,
      postSnapshot,
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: vi.fn(),
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    expect(readMarkdown).not.toHaveBeenCalled();
    expect(postSnapshot).not.toHaveBeenCalled();
    expect(frameCallbacks).toHaveLength(1);

    frameCallbacks[0]!(0);

    expect(readMarkdown).toHaveBeenCalledTimes(1);
    expect(postSnapshot).toHaveBeenCalledWith('# Latest\n');
  });

  it('coalesces repeated native snapshots for a large document into one full read', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const largeMarkdown = `${'# Large\n'}${'x'.repeat(1024 * 1024)}`;
    const readMarkdown = vi.fn(() => largeMarkdown);
    const postSnapshot = vi.fn(() => true);
    const scheduler = createNativeMarkdownSnapshotScheduler({
      readMarkdown,
      postSnapshot,
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: vi.fn(),
    });

    for (let i = 0; i < 250; i += 1) {
      scheduler.schedule();
    }

    expect(frameCallbacks).toHaveLength(1);
    expect(readMarkdown).not.toHaveBeenCalled();
    expect(postSnapshot).not.toHaveBeenCalled();

    frameCallbacks[0]!(0);

    expect(readMarkdown).toHaveBeenCalledTimes(1);
    expect(postSnapshot).toHaveBeenCalledTimes(1);
    expect(postSnapshot).toHaveBeenCalledWith(largeMarkdown);
  });

  it('cancels pending native markdown snapshots when the editor is disposed', () => {
    const readMarkdown = vi.fn(() => '# Disposed\n');
    const postSnapshot = vi.fn(() => true);
    const cancelFrame = vi.fn();
    const scheduler = createNativeMarkdownSnapshotScheduler({
      readMarkdown,
      postSnapshot,
      requestFrame: () => 42,
      cancelFrame,
    });

    scheduler.schedule();
    scheduler.cancel();

    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(readMarkdown).not.toHaveBeenCalled();
    expect(postSnapshot).not.toHaveBeenCalled();
  });

  it('applies native disk markdown only when provider text still matches the baseline', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    ytext.insert(0, 'Base\n');
    const origins: unknown[] = [];
    ydoc.on('afterTransaction', (transaction) => {
      origins.push(transaction.origin);
    });

    expect(applyNativeDiskMarkdownToText(
      ytext,
      (callback, origin) => ydoc.transact(callback, origin),
      'Disk\n',
      'Base\n',
    )).toEqual({ ok: true, markdown: 'Disk\n' });
    expect(ytext.toString()).toBe('Disk\n');
    expect(origins).toContain('marklab.native.disk');

    expect(applyNativeDiskMarkdownToText(
      ytext,
      (callback, origin) => ydoc.transact(callback, origin),
      'Other disk\n',
      'Base\n',
    )).toEqual({ ok: false, reason: 'provider_changed', providerMarkdown: 'Disk\n' });
    expect(ytext.toString()).toBe('Disk\n');
  });

  it('accepts local conflict resolution when provider text still matches the shared conflict side', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    ytext.insert(0, 'Shared\n');
    const origins: unknown[] = [];
    ydoc.on('afterTransaction', (transaction) => {
      origins.push(transaction.origin);
    });

    const result = applyNativeDiskMarkdownToText(
      ytext,
      (callback, origin) => ydoc.transact(callback, origin),
      'Local\n',
      'Shared\n',
    );

    expect(result).toEqual({ ok: true, markdown: 'Local\n' });
    expect(ytext.toString()).toBe('Local\n');
    expect(origins).toContain('marklab.native.disk');
  });

  it('applies disk edits as an incremental middle-span transaction', () => {
    const operations: Array<{ type: 'delete'; index: number; length: number } | { type: 'insert'; index: number; text: string }> = [];
    let value = 'hello world';
    const text = {
      get length() { return value.length; },
      toString: () => value,
      delete: (index: number, length: number) => {
        operations.push({ type: 'delete', index, length });
        value = `${value.slice(0, index)}${value.slice(index + length)}`;
      },
      insert: (index: number, insertedText: string) => {
        operations.push({ type: 'insert', index, text: insertedText });
        value = `${value.slice(0, index)}${insertedText}${value.slice(index)}`;
      },
    };
    const origins: string[] = [];

    const result = applyNativeDiskMarkdownToText(
      text,
      (callback, origin) => {
        origins.push(origin);
        callback();
      },
      'hello brave world',
      'hello world',
    );

    expect(result).toEqual({ ok: true, markdown: 'hello brave world' });
    expect(value).toBe('hello brave world');
    expect(operations).toEqual([{ type: 'insert', index: 6, text: 'brave ' }]);
    expect(origins).toEqual(['marklab.native.disk']);
  });
});
