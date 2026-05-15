import { useEffect, useMemo, useRef, useState } from 'react';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { EVENT_CONNECTION_STATUS, STATUS_CONNECTED, STATUS_CONNECTING, STATUS_ERROR, STATUS_OFFLINE } from '@y-sweet/client';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
  createActiveEditSession,
  createCollabSessionClient,
  isTerminalProviderRefreshError,
  providerTokenRefreshDelayMs,
  providerTokenRefreshRetryDelayMs,
  type ActiveEditSession,
  type IssuedProviderToken,
} from '../api/collab-session';
import {
  createIndexedDbPersistenceKey,
  createYTextCodeMirrorBinding,
  type YTextCodeMirrorBinding,
} from './ytext-codemirror';
import {
  createAwarenessUser,
  createCursorAwareness,
  type MarkLabAwarenessState,
} from '../presence/awareness';
import {
  createRemoteCursorExtension,
  summarizeRemoteCursors,
  type RemoteCursorSummary,
} from '../presence/remote-cursors';
import { createMarkLabYjsProvider, type MarkLabYjsProvider } from '../provider/yjs-provider';

export interface CollaborativeMarkdownEditorProps {
  docId: string;
  branchId: string;
  token?: string | undefined;
  displayName?: string | undefined;
}

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unavailable';

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting';
    case 'offline':
      return 'Offline';
    case 'unavailable':
      return 'Unavailable';
    case 'connecting':
      return 'Connecting';
  }
}

function providerStateToConnectionState(value: unknown): ConnectionState {
  const status = typeof value === 'object' && value && 'status' in value ? (value as { status?: unknown }).status : value;
  if (status === STATUS_CONNECTED) return 'connected';
  if (status === STATUS_CONNECTING) return 'connecting';
  if (status === STATUS_OFFLINE) return 'offline';
  if (status === STATUS_ERROR) return 'reconnecting';
  return 'reconnecting';
}

function bindSessionIdentity(ydoc: Y.Doc, providerToken: IssuedProviderToken): void {
  if (!providerToken.sessionIdentity) return;
  const permanentUserData = new Y.PermanentUserData(ydoc);
  permanentUserData.setUserMapping(ydoc, ydoc.clientID, JSON.stringify(providerToken.sessionIdentity));
}

export function CollaborativeMarkdownEditor({
  docId,
  branchId,
  token,
  displayName = 'Guest',
}: CollaborativeMarkdownEditorProps) {
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState('');
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursorSummary[]>([]);
  const client = useMemo(() => createCollabSessionClient(), []);

  useEffect(() => {
    if (!editorHostRef.current) return;
    if (!docId || !branchId) {
      setConnectionState('unavailable');
      setUnavailableReason('missing_document_route');
      return;
    }

    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let view: EditorView | null = null;
    let binding: YTextCodeMirrorBinding | null = null;
    let provider: MarkLabYjsProvider | null = null;
    let persistence: IndexeddbPersistence | null = null;
    let awareness: Awareness | null = null;
    let unavailable = false;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    const editableCompartment = new Compartment();
    const providerTokenRef: { current: IssuedProviderToken | null } = { current: null };
    const activeSessionRef: { current: ActiveEditSession | null } = { current: null };

    const markUnavailable = (reason: string) => {
      if (disposed) return;
      unavailable = true;
      provider?.disconnect();
      view?.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(false)) });
      if (refreshTimer) clearTimeout(refreshTimer);
      setConnectionState('unavailable');
      setUnavailableReason(reason);
    };

    const attemptRefresh = (allowImmediateAfterSuccess: boolean) => {
      const activeSession = activeSessionRef.current;
      if (!activeSession || unavailable || disposed) return;
      void client.refreshProviderToken(activeSession).then((nextToken) => {
        if (disposed || unavailable) return;
        if (
          nextToken.providerDocId !== activeSession.providerToken.providerDocId ||
          nextToken.sessionId !== activeSession.sessionId ||
          nextToken.authorization !== 'full' ||
          nextToken.clientToken.authorization !== 'full'
        ) {
          markUnavailable('invalid_provider_token_refresh');
          return;
        }
        activeSessionRef.current = { ...activeSession, providerToken: nextToken };
        providerTokenRef.current = nextToken;
        try {
          provider?.replaceClientToken(nextToken.clientToken);
        } catch (replaceError) {
          markUnavailable(replaceError instanceof Error ? replaceError.message : 'invalid_provider_token_refresh');
          return;
        }
        scheduleRefresh(nextToken, allowImmediateAfterSuccess);
      }).catch((error: unknown) => {
        if (disposed || unavailable) return;
        if (isTerminalProviderRefreshError(error)) {
          markUnavailable(error instanceof Error ? error.message : 'provider_token_refresh_denied');
          return;
        }
        if (!unavailable && !disposed) setConnectionState('reconnecting');
        scheduleRetry();
      });
    };

    const scheduleRetry = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        attemptRefresh(true);
      }, providerTokenRefreshRetryDelayMs());
    };

    const scheduleRefresh = (providerToken: IssuedProviderToken, allowImmediate = true) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      const refreshDelayMs = providerTokenRefreshDelayMs(
        providerToken,
        Date.now(),
        undefined,
        { allowImmediate },
      );
      refreshTimer = setTimeout(() => {
        attemptRefresh(refreshDelayMs > 0);
      }, refreshDelayMs);
    };

    void client.createSession({
      docId,
      branchId,
      mode: 'edit',
      displayName,
      token,
    }).then((session) => {
      if (disposed || session.mode !== 'edit' || !editorHostRef.current) return;
      activeSessionRef.current = createActiveEditSession({ docId, branchId }, session);
      providerTokenRef.current = session.providerToken;
      bindSessionIdentity(ydoc, session.providerToken);
      awareness = new Awareness(ydoc);
      const localUser = createAwarenessUser({
        sessionId: session.session.sessionId,
        displayName,
        kind: session.providerToken.sessionIdentity?.actorType === 'agent' ? 'agent' : 'human',
      });
      awareness.setLocalStateField('user', localUser);
      const syncRemoteCursorSummaries = () => {
        if (!awareness) return;
        setRemoteCursors(summarizeRemoteCursors(
          awareness.getStates() as ReadonlyMap<number, MarkLabAwarenessState>,
          ydoc.clientID,
        ));
      };
      awareness.on('change', syncRemoteCursorSummaries);
      persistence = new IndexeddbPersistence(
        createIndexedDbPersistenceKey(session.providerToken.providerDocId, session.session.sessionId),
        ydoc,
      );
      const publishLocalCursor = () => {
        if (!awareness || !view) return;
        if (!view.hasFocus) {
          awareness.setLocalStateField('cursor', null);
          return;
        }
        const selection = view.state.selection.main;
        const nextAwareness = createCursorAwareness(
          ytext,
          { anchor: selection.anchor, head: selection.head },
          localUser,
        );
        awareness.setLocalStateField('cursor', nextAwareness.cursor);
      };
      view = new EditorView({
        parent: editorHostRef.current,
        state: EditorState.create({
          doc: ytext.toString(),
          extensions: [
            markdown(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.lineWrapping,
            editableCompartment.of(EditorView.editable.of(true)),
            createRemoteCursorExtension({ awareness, ytext, localClientId: ydoc.clientID }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) setMarkdownPreview(update.state.doc.toString());
              if (update.selectionSet || update.focusChanged) publishLocalCursor();
            }),
          ],
        }),
      });
      binding = createYTextCodeMirrorBinding({ view, ytext, preferInitial: 'ytext' });
      setMarkdownPreview(view.state.doc.toString());
      provider = createMarkLabYjsProvider(
        ydoc,
        session.providerToken.providerDocId,
        async () => {
          if (!providerTokenRef.current) throw new Error('provider_token_missing');
          return providerTokenRef.current.clientToken;
        },
        {
          awareness,
          initialClientToken: session.providerToken.clientToken,
          connect: true,
          offlineSupport: false,
          showDebuggerLink: false,
        },
      );
      provider.on(EVENT_CONNECTION_STATUS, (event) => {
        if (unavailable) return;
        setConnectionState(providerStateToConnectionState(event));
      });
      setConnectionState('connecting');
      scheduleRefresh(session.providerToken);
    }).catch((error: unknown) => {
      markUnavailable(error instanceof Error ? error.message : 'collab_session_unavailable');
    });

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      binding?.destroy();
      view?.destroy();
      provider?.destroy();
      persistence?.destroy();
      awareness?.destroy();
      ydoc.destroy();
    };
  }, [branchId, client, displayName, docId, token]);

  return (
    <main className="collab-shell">
      <header className="collab-topbar">
        <div>
          <h1>MarkLab</h1>
          <p>Edit session</p>
        </div>
        <span className={`connection-pill ${connectionState}`}>{connectionLabel(connectionState)}</span>
      </header>
      {unavailableReason ? (
        <section className="unavailable-banner" role="status">
          {unavailableReason}
        </section>
      ) : null}
      <section className="editor-grid" aria-label="Collaborative Markdown editor">
        <div
          className="source-pane codemirror-source-pane"
          aria-label="Markdown source"
          data-doc-id={docId}
          data-branch-id={branchId}
          ref={editorHostRef}
        >
        </div>
        <aside className="preview-pane" aria-label="Live preview">
          {remoteCursors.length > 0 ? (
            <div className="presence-strip" aria-label="Collaborators">
              {remoteCursors.map((cursor) => (
                <span key={cursor.clientId} style={{ borderColor: cursor.color }}>
                  {cursor.name}
                </span>
              ))}
            </div>
          ) : null}
          <pre>{markdownPreview || '# Untitled\n'}</pre>
        </aside>
      </section>
    </main>
  );
}
