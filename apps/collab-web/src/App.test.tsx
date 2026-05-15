// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ySweetClient from '@y-sweet/client';
import { App } from './App';

vi.mock('@y-sweet/client', async () => {
  const actual = await vi.importActual<typeof import('@y-sweet/client')>('@y-sweet/client');
  return {
    ...actual,
    createYjsProvider: vi.fn(),
  };
});

function viewSessionResponse(): Response {
  return new Response(JSON.stringify({
    mode: 'view',
    session: { sessionId: 'session_view', clientKind: 'browser', displayName: 'Guest' },
    document: {
      docId: 'doc_1',
      branchId: 'branch_1',
      versionId: null,
      versionNumber: null,
      hash: 'sha256:view',
      markdown: '# View-only\n',
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('App routing', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/?mode=view&docId=doc_1&branchId=branch_1&token=view_token');
    vi.stubGlobal('fetch', vi.fn(async () => viewSessionResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not call the provider connection factory for view mode', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'View-only' })).toBeTruthy();
    expect(ySweetClient.createYjsProvider).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      '/api/docs/doc_1/branches/branch_1/collab/session?token=view_token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'view', clientKind: 'browser', displayName: 'Guest' }),
      }),
    );
  });
});
