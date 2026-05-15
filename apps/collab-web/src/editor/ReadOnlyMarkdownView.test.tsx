// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReadOnlyMarkdownView } from './ReadOnlyMarkdownView';

describe('ReadOnlyMarkdownView', () => {
  it('creates a view session and renders selectable Markdown without mounting an editor', async () => {
    const client = {
      createSession: vi.fn(async () => ({
        mode: 'view' as const,
        session: { sessionId: 'session_view', clientKind: 'browser', displayName: 'Reader' },
        document: {
          docId: 'doc_1',
          branchId: 'branch_1',
          versionId: 'ver_1',
          versionNumber: 3,
          hash: 'sha256:view',
          markdown: [
            '# Shared',
            '',
            'Body with **bold**, `code`, [MarkLab](https://example.com), and [protocol](//attacker.example/path).',
            '',
            '1. First',
            '2. Second',
            '',
            '- [x] Done',
            '',
            '| A | B |',
            '| - | - |',
            '| 1 | 2 |',
            '',
            '![diagram](https://attacker.example/pixel.png)',
            '',
            '<script>alert(1)</script>',
          ].join('\n'),
        },
      })),
    };

    render(
      <ReadOnlyMarkdownView
        docId="doc_1"
        branchId="branch_1"
        token="view_token"
        displayName="Reader"
        client={client}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Shared' })).toBeTruthy();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: 'MarkLab' }).getAttribute('href')).toBe('https://example.com');
    expect(screen.getByRole('link', { name: 'MarkLab' }).getAttribute('rel')).toBe('noreferrer noopener');
    expect(screen.getByRole('link', { name: 'protocol' }).getAttribute('rel')).toBe('noreferrer noopener');
    expect(screen.getByText('First')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '2' })).toBeTruthy();
    expect(screen.getByText('Image: diagram')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(client.createSession).toHaveBeenCalledWith({
      docId: 'doc_1',
      branchId: 'branch_1',
      mode: 'view',
      displayName: 'Reader',
      token: 'view_token',
    });
    expect(document.querySelector('.cm-editor')).toBeNull();
  });
});
