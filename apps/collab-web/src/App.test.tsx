// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ySweetClient from '@y-sweet/client';
import { App, collabClientKindFromParam, collabNativeShellFromParam } from './App';

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

function downgradedNativeEditSessionResponse(): Response {
  return new Response(JSON.stringify({
    mode: 'edit',
    session: {
      sessionId: 'session_downgraded',
      clientKind: 'browser',
      displayName: 'MarkLab.app',
      refreshToken: 'refresh_session_secret',
    },
    providerToken: {
      providerDocId: 'ml_doc_1',
      sessionId: 'session_downgraded',
      authorization: 'full',
      validForSeconds: 600,
      issuedAt: '2026-05-15T12:00:00.000Z',
      expiresAt: '2026-05-15T12:10:00.000Z',
      clientToken: {
        docId: 'ml_doc_1',
        url: 'ws://api.example.test/d/ml_doc_1/ws/ml_doc_1',
        baseUrl: 'https://api.example.test/d/ml_doc_1',
        token: 'ysweet_token',
        authorization: 'full',
      },
    },
  }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

function nativeEditSessionResponse(): Response {
  return new Response(JSON.stringify({
    mode: 'edit',
    session: {
      sessionId: 'session_app',
      clientKind: 'app',
      displayName: 'MarkLab.app',
      refreshToken: 'refresh_session_secret',
    },
    providerToken: {
      providerDocId: 'ml_doc_1',
      sessionId: 'session_app',
      authorization: 'full',
      validForSeconds: 600,
      issuedAt: '2026-05-15T12:00:00.000Z',
      expiresAt: '2026-05-15T12:10:00.000Z',
      clientToken: {
        docId: 'ml_doc_1',
        url: 'memory://ml_doc_1',
        baseUrl: 'memory://ml_doc_1',
        token: 'memory_token',
        authorization: 'full',
      },
    },
  }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('App routing', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/?mode=view&docId=doc_1&branchId=branch_1&token=view_token');
    vi.stubGlobal('fetch', vi.fn(async () => viewSessionResponse()));
  });

  afterEach(() => {
    delete window.__marklabNativeApp;
    delete window.__marklabNativeApplyDiskMarkdown;
    delete window.__marklabRunEditorCommand;
    delete window.__marklabSetNativeEditable;
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

  it('uses app clientKind only when the native wrapper marks the embedded route', () => {
    expect(collabClientKindFromParam('app', true)).toBe('app');
    expect(collabClientKindFromParam('app', false)).toBe('browser');
    expect(collabClientKindFromParam('browser')).toBe('browser');
    expect(collabClientKindFromParam(null)).toBe('browser');
  });

  it('uses MarkEdit native shell styling only inside the native wrapper', () => {
    expect(collabNativeShellFromParam('markedit', true)).toBe('markedit');
    expect(collabNativeShellFromParam('markedit', false)).toBeUndefined();
    expect(collabNativeShellFromParam(null, true)).toBeUndefined();
  });

  it('marks native embedded edit unavailable when the server downgrades clientKind', async () => {
    window.__marklabNativeApp = true;
    window.history.pushState({}, '', '/?mode=edit&docId=doc_1&branchId=branch_1&clientKind=app');
    vi.stubGlobal('fetch', vi.fn(async () => downgradedNativeEditSessionResponse()));

    render(<App />);

    expect(await screen.findByText('invalid_edit_session_client_kind')).toBeTruthy();
    expect(ySweetClient.createYjsProvider).not.toHaveBeenCalled();
  });

  it('keeps native conflict resolution ingestion available while native direct editing is read-only', async () => {
    window.__marklabNativeApp = true;
    window.history.pushState({}, '', '/?mode=edit&docId=doc_1&branchId=branch_1&clientKind=app&nativeShell=markedit');
    vi.stubGlobal('fetch', vi.fn(async () => nativeEditSessionResponse()));

    render(<App />);

    await waitFor(() => {
      expect(window.__marklabSetNativeEditable).toBeTypeOf('function');
      expect(window.__marklabNativeApplyDiskMarkdown).toBeTypeOf('function');
    });

    expect(window.__marklabSetNativeEditable?.(false)).toBe(true);
    expect(window.__marklabNativeApplyDiskMarkdown?.('Resolved\n', '')).toEqual({
      ok: true,
      markdown: 'Resolved\n',
    });
  });
});
