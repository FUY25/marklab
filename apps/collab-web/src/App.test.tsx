// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ySweetClient from '@y-sweet/client';
import { createCursorAwareness, remoteCursorLabelVisibleMs, type MarkLabAwarenessUser } from '@marklab/collab-editor';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { App, collabClientKindFromParam, collabNativeShellFromParam } from './App';
import { AuthCallbackPage, SignInPage } from './auth/AuthFlow';

const providerMock = vi.hoisted(() => ({
  capturedAwareness: null as Awareness | null,
  destroy: vi.fn(),
  off: vi.fn(),
  on: vi.fn(),
}));

vi.mock('@y-sweet/client', async () => {
  const actual = await vi.importActual<typeof import('@y-sweet/client')>('@y-sweet/client');
  return {
    ...actual,
    createYjsProvider: vi.fn((_doc, _providerDocId, _clientTokenFactory, options) => {
      providerMock.capturedAwareness = (options as { awareness?: typeof providerMock.capturedAwareness }).awareness ?? null;
      return {
        clientToken: null,
        destroy: providerMock.destroy,
        disconnect: vi.fn(),
        off: providerMock.off,
        on: providerMock.on,
        status: actual.STATUS_CONNECTED,
      };
    }),
  };
});

// jsdom has no indexedDB. The App-level routing tests do not exercise offline
// persistence; they only assert that the editor mounts, exposes the native
// bridges, and that provider construction is/isn't called. Stub y-indexeddb so
// that constructing CollaborativeMarkdownEditor does not throw
// `ReferenceError: indexedDB is not defined` and fail the run. See bug.md
// "Unfixed Stop Point" (collab-web vitest indexedDB).
vi.mock('y-indexeddb', () => {
  class IndexeddbPersistenceStub {
    whenSynced: Promise<void> = Promise.resolve();
    on(): void {}
    off(): void {}
    destroy(): Promise<void> {
      return Promise.resolve();
    }
    clearData(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { IndexeddbPersistence: IndexeddbPersistenceStub };
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

function nativeHostedEditSessionResponse(): Response {
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

describe('App routing', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/?mode=view&docId=doc_1&branchId=branch_1&token=view_token');
    vi.stubGlobal('fetch', vi.fn(async () => viewSessionResponse()));
    providerMock.capturedAwareness = null;
    providerMock.destroy.mockReset();
    providerMock.off.mockReset();
    providerMock.on.mockReset();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
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
    await waitFor(() => {
      expect(document.querySelectorAll('.markedit-native-shell .cm-editor')).toHaveLength(1);
      expect(document.querySelector('.markedit-native-shell .cm-lineNumbers')).toBeTruthy();
    });
    expect(document.querySelector('.markedit-native-shell .preview-pane')).toBeNull();

    expect(window.__marklabSetNativeEditable?.(false)).toBe(true);
    expect(window.__marklabNativeApplyDiskMarkdown?.('Resolved\n', '')).toEqual({
      ok: true,
      markdown: 'Resolved\n',
    });
  });

  it('uses the logged-in native account name for app edit sessions', async () => {
    window.__marklabNativeApp = true;
    window.history.pushState({}, '', '/?mode=edit&docId=doc_1&branchId=branch_1&clientKind=app&nativeShell=markedit&name=Alice%20OIDC');
    vi.stubGlobal('fetch', vi.fn(async () => nativeEditSessionResponse()));

    render(<App />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/docs/doc_1/branches/branch_1/collab/session',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ mode: 'edit', clientKind: 'app', displayName: 'Alice OIDC' }),
        }),
      );
    });
  });

  it('does not publish a source-pane cursor until the user explicitly places one', async () => {
    window.__marklabNativeApp = true;
    window.history.pushState({}, '', '/?mode=edit&docId=doc_1&branchId=branch_1&clientKind=app&nativeShell=markedit');
    vi.stubGlobal('fetch', vi.fn(async () => nativeHostedEditSessionResponse()));

    render(<App />);

    await waitFor(() => {
      expect(providerMock.capturedAwareness).not.toBeNull();
      expect(document.querySelectorAll('.markedit-native-shell .cm-editor')).toHaveLength(1);
    });
    const awareness = providerMock.capturedAwareness!;
    const view = (window as unknown as { __marklabEditorView?: { focus(): void; dispatch(input: { selection: { anchor: number } }): void } }).__marklabEditorView;
    expect(view).toBeTruthy();
    expect(awareness.getLocalState()?.cursor).toBeUndefined();

    view!.focus();
    await Promise.resolve();
    expect(awareness.getLocalState()?.cursor).toBeUndefined();

    view!.dispatch({ selection: { anchor: 0 } });
    await waitFor(() => {
      expect(awareness.getLocalState()?.cursor).toBeTruthy();
    });
  });

  it('renders native remote cursors through inline CodeMirror widgets with transient labels', async () => {
    window.__marklabNativeApp = true;
    window.history.pushState({}, '', '/?mode=edit&docId=doc_1&branchId=branch_1&clientKind=app&nativeShell=markedit');
    vi.stubGlobal('fetch', vi.fn(async () => nativeHostedEditSessionResponse()));

    render(<App />);

    await waitFor(() => {
      expect(providerMock.capturedAwareness).not.toBeNull();
      expect(document.querySelectorAll('.markedit-native-shell .cm-editor')).toHaveLength(1);
    });

    const localAwareness = providerMock.capturedAwareness!;
    const ytext = localAwareness.doc.getText('contents');
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDoc);
    const remoteUser: MarkLabAwarenessUser = {
      id: 'session_browser',
      name: 'Guest',
      color: '#2563eb',
      colorLight: '#dbeafe',
      kind: 'human',
      clientKind: 'browser',
    };
    try {
      remoteAwareness.setLocalState(createCursorAwareness(ytext, { anchor: 0, head: 0 }, remoteUser));
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        'test',
      );

      await waitFor(() => {
        expect(document.querySelectorAll('.cm-marklab-remote-caret')).toHaveLength(1);
      });
      expect(document.querySelector('.cm-marklab-remote-caret-label')?.textContent).toBe('Guest');
      expect(document.querySelector('.cm-marklab-remote-caret-label-visible')).toBeTruthy();
      expect(document.querySelector('.cm-marklab-remote-cursor-overlay')).toBeNull();

      await new Promise((resolve) => {
        setTimeout(resolve, remoteCursorLabelVisibleMs + 20);
      });

      expect(document.querySelectorAll('.cm-marklab-remote-caret')).toHaveLength(1);
      expect(document.querySelector('.cm-marklab-remote-caret-label')).not.toBeNull();
      expect(document.querySelector('.cm-marklab-remote-caret-label-visible')).toBeNull();
    } finally {
      remoteAwareness.destroy();
      remoteDoc.destroy();
    }
  });

  it('broadcasts local awareness removal before destroying the hosted provider', async () => {
    window.__marklabNativeApp = true;
    window.history.pushState({}, '', '/?mode=edit&docId=doc_1&branchId=branch_1&clientKind=app&nativeShell=markedit');
    vi.stubGlobal('fetch', vi.fn(async () => nativeHostedEditSessionResponse()));
    const teardownOrder: string[] = [];
    providerMock.destroy.mockImplementation(() => {
      teardownOrder.push('provider-destroyed');
    });

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(providerMock.capturedAwareness).not.toBeNull();
      expect(document.querySelectorAll('.markedit-native-shell .cm-editor')).toHaveLength(1);
    });
    const awareness = providerMock.capturedAwareness!;
    awareness.on('update', (event: { removed: number[] }) => {
      if (event.removed.includes(awareness.clientID)) {
        teardownOrder.push('awareness-cleared');
      }
    });

    unmount();

    expect(providerMock.destroy).toHaveBeenCalledTimes(1);
    expect(teardownOrder.slice(0, 2)).toEqual(['awareness-cleared', 'provider-destroyed']);
  });
});

describe('OIDC auth flow', () => {
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('starts OIDC with server-side native handoff intent before redirecting', async () => {
    const redirect = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      authorizationUrl: 'https://login.example.test/authorize?state=state_1',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<SignInPage nativeMode appState="native_state_native_state_native_state_1" redirect={redirect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/auth/oidc/start', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ native: true, appState: 'native_state_native_state_native_state_1' }),
      }));
      expect(redirect).toHaveBeenCalledWith('https://login.example.test/authorize?state=state_1');
    });
  });

  it('shows a readable sign-in failure when OIDC is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'oidc_not_configured',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<SignInPage nativeMode />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Google sign-in is not configured for this environment.');
  });

  it('shows a native state error when native sign-in was not launched from the app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'native_auth_state_required',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<SignInPage nativeMode />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Open sign-in from MarkLab.app and try again.');
  });

  it('turns the OIDC callback session into a native app callback URL', async () => {
    const redirect = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      token: 'ml_user_secret',
      nativeCallback: true,
      nativeAppState: 'native_state_native_state_native_state_1',
      user: {
        userId: 'user_1',
        email: 'alice@example.test',
        displayName: 'Alice OIDC',
      },
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<AuthCallbackPage search="?code=oidc_code&state=oidc_state" redirect={redirect} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/auth/oidc/callback', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ code: 'oidc_code', state: 'oidc_state' }),
      }));
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining('marklab://auth/callback?'));
    });
    expect(redirect.mock.calls[0]?.[0]).toContain('displayName=Alice+OIDC');
    expect(redirect.mock.calls[0]?.[0]).toContain('appState=native_state_native_state_native_state_1');
    expect(screen.getByRole('link', { name: 'Open MarkLab' }).getAttribute('href')).toContain('marklab://auth/callback?');
  });

  it('rejects native callback responses missing the server-bound app state', async () => {
    const redirect = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      token: 'ml_user_secret',
      nativeCallback: true,
      user: {
        userId: 'user_1',
        email: 'alice@example.test',
        displayName: 'Alice OIDC',
      },
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<AuthCallbackPage search="?code=oidc_code&state=oidc_state" redirect={redirect} />);

    expect((await screen.findByRole('alert')).textContent).toContain('The sign-in response was not recognized.');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects browser sign-in back to same-origin relative workspace settings returnTo', async () => {
    const redirect = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      token: 'ml_user_secret',
      returnTo: '/workspaces/ws_1/settings',
      user: {
        userId: 'user_1',
        email: 'alice@example.test',
        displayName: 'Alice OIDC',
      },
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<AuthCallbackPage search="?code=oidc_code&state=oidc_state" redirect={redirect} />);

    await waitFor(() => {
      expect(redirect).toHaveBeenCalledWith('/workspaces/ws_1/settings');
    });
  });

  it('shows a readable callback failure when code or state is missing', async () => {
    render(<AuthCallbackPage search="?code=oidc_code" redirect={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('The sign-in response is missing required details.');
  });
});
