// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { applyNativeDiskMarkdownToText, postNativeMarkdownSnapshot } from './native-bridge';

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

  it('is a no-op in normal browser sessions', () => {
    expect(postNativeMarkdownSnapshot('# Browser\n')).toBe(false);
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
