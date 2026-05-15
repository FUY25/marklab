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
          markdown: '# Shared\n\nBody\n\n- One\n- Two\n\n<script>alert(1)</script>',
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
    expect(screen.getByText('Body')).toBeTruthy();
    expect(screen.getByText('One')).toBeTruthy();
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
