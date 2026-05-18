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
  createAwarenessUser,
  createCollabSessionClient,
  createCursorAwareness,
  createIndexedDbPersistenceKey,
  createRemoteCursorExtension,
  createYTextCodeMirrorBinding,
  isTerminalProviderRefreshError,
  providerTokenRefreshDelayMs,
  providerTokenRefreshRetryDelayMs,
  summarizeRemoteCursors,
  ySyncAnnotation,
  type ActiveEditSession,
  type IssuedProviderToken,
  type MarkLabAwarenessState,
  type RefreshableEditSession,
  type RemoteCursorSummary,
  type YTextCodeMirrorBinding,
} from '@marklab/collab-editor';
import {
  runMarkdownEditorCommand,
  type MarkdownEditorCommand,
} from '@marklab/collab-editor/markdown-commands';
import {
  clearPersistedEditSession,
  loadPersistedEditSession,
  persistEditSession,
  type PersistedEditSession,
} from '../api/edit-session-storage';
import { createMarkLabYjsProvider, type MarkLabYjsProvider } from '../provider/yjs-provider';
import { renderMarkdownSnapshot } from './markdown-render';
import { applyNativeDiskMarkdownToText, postNativeMarkdownSnapshot } from './native-bridge';

type CollabClientKind = 'browser' | 'app';

export interface CollaborativeMarkdownEditorProps {
  docId: string;
  branchId: string;
  token?: string | undefined;
  displayName?: string | undefined;
  clientKind?: CollabClientKind | undefined;
  nativeShell?: 'markedit' | undefined;
}

declare global {
  interface Window {
    __marklabRunEditorCommand?: (command: MarkdownEditorCommand) => boolean;
    __marklabSetNativeEditable?: (editable: boolean) => boolean;
  }
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

function isConnectedProviderStatus(status: unknown): boolean {
  return status === STATUS_CONNECTED || (
    typeof status === 'object' &&
    status !== null &&
    'status' in status &&
    (status as { status?: unknown }).status === STATUS_CONNECTED
  );
}

function bindSessionIdentity(ydoc: Y.Doc, providerToken: IssuedProviderToken): void {
  if (!providerToken.sessionIdentity) return;
  const permanentUserData = new Y.PermanentUserData(ydoc);
  permanentUserData.setUserMapping(ydoc, ydoc.clientID, JSON.stringify(providerToken.sessionIdentity));
}

interface EditorSession extends RefreshableEditSession {
  providerDocId: string;
  providerToken: IssuedProviderToken | null;
}

function editorSessionFromActiveSession(activeSession: ActiveEditSession): EditorSession {
  return {
    docId: activeSession.docId,
    branchId: activeSession.branchId,
    sessionId: activeSession.sessionId,
    refreshToken: activeSession.refreshToken,
    providerDocId: activeSession.providerToken.providerDocId,
    providerToken: activeSession.providerToken,
  };
}

function editorSessionFromPersistedSession(persistedSession: PersistedEditSession): EditorSession {
  return {
    ...persistedSession,
    providerToken: null,
  };
}

function activeSessionFromEditorSession(session: EditorSession, providerToken: IssuedProviderToken): ActiveEditSession {
  return {
    docId: session.docId,
    branchId: session.branchId,
    sessionId: session.sessionId,
    refreshToken: session.refreshToken,
    providerToken,
  };
}

function validateProviderTokenForSession(session: Pick<EditorSession, 'sessionId' | 'providerDocId'>, providerToken: IssuedProviderToken): string | null {
  if (
    providerToken.providerDocId !== session.providerDocId ||
    providerToken.sessionId !== session.sessionId ||
    providerToken.clientToken.docId !== session.providerDocId
  ) {
    return 'invalid_provider_token_refresh';
  }
  if (providerToken.authorization !== 'full' || providerToken.clientToken.authorization !== 'full') {
    return 'invalid_provider_token_refresh';
  }
  return null;
}

export function CollaborativeMarkdownEditor({
  docId,
  branchId,
  token,
  displayName = 'Guest',
  clientKind = 'browser',
  nativeShell,
}: CollaborativeMarkdownEditorProps) {
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState('');
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursorSummary[]>([]);
  const client = useMemo(() => createCollabSessionClient({ clientKind }), [clientKind]);

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
    let nativeEditable = true;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    const editableCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    const providerTokenRef: { current: IssuedProviderToken | null } = { current: null };
    const activeSessionRef: { current: EditorSession | null } = { current: null };
    const storageKeyInput = { docId, branchId, token };

    function reconfigureEditability() {
      view?.dispatch({
        effects: [
          editableCompartment.reconfigure(EditorView.editable.of(!unavailable && nativeEditable)),
          readOnlyCompartment.reconfigure(EditorState.readOnly.of(unavailable || !nativeEditable)),
        ],
      });
    }

    function markUnavailable(reason: string) {
      if (disposed) return;
      unavailable = true;
      clearPersistedEditSession(storageKeyInput);
      provider?.terminate();
      reconfigureEditability();
      if (refreshTimer) clearTimeout(refreshTimer);
      setConnectionState('unavailable');
      setUnavailableReason(reason);
    }

    function scheduleRetry() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        attemptRefresh(true);
      }, providerTokenRefreshRetryDelayMs());
    }

    function scheduleRefresh(providerToken: IssuedProviderToken, allowImmediate = true) {
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
    }

    function installProviderToken(
      session: EditorSession,
      nextToken: IssuedProviderToken,
      allowImmediateAfterSuccess: boolean,
    ): boolean {
      const invalidReason = validateProviderTokenForSession(session, nextToken);
      if (invalidReason) {
        markUnavailable(invalidReason);
        return false;
      }
      const nextSession: EditorSession = {
        ...session,
        providerDocId: nextToken.providerDocId,
        providerToken: nextToken,
      };
      activeSessionRef.current = nextSession;
      providerTokenRef.current = nextToken;
      persistEditSession(storageKeyInput, activeSessionFromEditorSession(nextSession, nextToken));
      try {
        if (provider) {
          provider.replaceClientToken(nextToken.clientToken);
        } else if (awareness) {
          bindSessionIdentity(ydoc, nextToken);
          provider = createMarkLabYjsProvider(
            ydoc,
            nextToken.providerDocId,
            async () => {
              if (!providerTokenRef.current) throw new Error('provider_token_missing');
              return providerTokenRef.current.clientToken;
            },
            {
              awareness,
              initialClientToken: nextToken.clientToken,
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
        }
      } catch (replaceError) {
        markUnavailable(replaceError instanceof Error ? replaceError.message : 'invalid_provider_token_refresh');
        return false;
      }
      if (isConnectedProviderStatus(provider?.status?.())) setConnectionState('connected');
      scheduleRefresh(nextToken, allowImmediateAfterSuccess);
      return true;
    }

    function attemptRefresh(allowImmediateAfterSuccess: boolean) {
      const activeSession = activeSessionRef.current;
      if (!activeSession || unavailable || disposed) return;
      void client.refreshProviderToken(activeSession).then((nextToken) => {
        if (disposed || unavailable) return;
        installProviderToken(activeSession, nextToken, allowImmediateAfterSuccess);
      }).catch((error: unknown) => {
        if (disposed || unavailable) return;
        if (isTerminalProviderRefreshError(error)) {
          markUnavailable(error instanceof Error ? error.message : 'provider_token_refresh_denied');
          return;
        }
        if (!unavailable && !disposed) setConnectionState('reconnecting');
        scheduleRetry();
      });
    }

    const createFreshEditSession = async (): Promise<EditorSession> => {
      const session = await client.createSession({
        docId,
        branchId,
        mode: 'edit',
        displayName,
        token,
      });
      if (session.mode !== 'edit') throw new Error('invalid_edit_session_response');
      if (clientKind === 'app' && session.session.clientKind !== 'app') {
        throw new Error('invalid_edit_session_client_kind');
      }
      const activeSession = createActiveEditSession({ docId, branchId }, session);
      persistEditSession(storageKeyInput, activeSession);
      return editorSessionFromActiveSession(activeSession);
    };

    const restoreOrCreateEditSession = async (): Promise<EditorSession> => {
      const persisted = clientKind === 'app' ? null : loadPersistedEditSession(storageKeyInput);
      if (persisted) {
        const restoredSession = editorSessionFromPersistedSession(persisted);
        try {
          const providerToken = await client.refreshProviderToken(persisted);
          const invalidReason = validateProviderTokenForSession(restoredSession, providerToken);
          if (invalidReason) throw new Error(invalidReason);
          const activeSession = activeSessionFromEditorSession(restoredSession, providerToken);
          persistEditSession(storageKeyInput, activeSession);
          return editorSessionFromActiveSession(activeSession);
        } catch (error) {
          if (isTerminalProviderRefreshError(error)) {
            clearPersistedEditSession(storageKeyInput);
            throw error;
          }
          if (error instanceof Error && error.message === 'invalid_provider_token_refresh') throw error;
          return restoredSession;
        }
      }

      return createFreshEditSession();
    };

    void restoreOrCreateEditSession().then((activeSession) => {
      if (disposed || !editorHostRef.current) return;
      activeSessionRef.current = activeSession;
      providerTokenRef.current = activeSession.providerToken;
      if (activeSession.providerToken) bindSessionIdentity(ydoc, activeSession.providerToken);
      awareness = new Awareness(ydoc);
      const localUser = createAwarenessUser({
        sessionId: activeSession.sessionId,
        displayName,
        kind: activeSession.providerToken?.sessionIdentity?.actorType === 'agent' ? 'agent' : 'human',
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
        createIndexedDbPersistenceKey(activeSession.providerDocId, activeSession.sessionId),
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
            editableCompartment.of(EditorView.editable.of(nativeEditable)),
            readOnlyCompartment.of(EditorState.readOnly.of(!nativeEditable)),
            EditorState.transactionFilter.of((transaction) => {
              if ((unavailable || !nativeEditable) && transaction.docChanged && !transaction.annotation(ySyncAnnotation)) return [];
              return transaction;
            }),
            createRemoteCursorExtension({ awareness, ytext, localClientId: ydoc.clientID }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                const markdown = update.state.doc.toString();
                setMarkdownPreview(markdown);
                postNativeMarkdownSnapshot(markdown);
              }
              if (update.selectionSet || update.focusChanged) publishLocalCursor();
            }),
          ],
        }),
      });
      binding = createYTextCodeMirrorBinding({ view, ytext, preferInitial: 'ytext' });
      window.__marklabNativeApplyDiskMarkdown = (markdown: string, baseline: string) => (
        unavailable ? { ok: false, reason: 'unavailable' } : applyNativeDiskMarkdownToText(
          ytext,
          (callback, origin) => ydoc.transact(callback, origin),
          markdown,
          baseline,
        )
      );
      window.__marklabRunEditorCommand = (command: MarkdownEditorCommand) => {
        if (!view || unavailable || !nativeEditable) return false;
        runMarkdownEditorCommand(view, command);
        return true;
      };
      window.__marklabSetNativeEditable = (editable: boolean) => {
        nativeEditable = editable;
        reconfigureEditability();
        return true;
      };
      if (import.meta.env.DEV) {
        (window as unknown as { __marklabEditorView?: EditorView }).__marklabEditorView = view;
      }
      const initialMarkdown = view.state.doc.toString();
      setMarkdownPreview(initialMarkdown);
      if (activeSession.providerToken) {
        installProviderToken(activeSession, activeSession.providerToken, true);
      } else {
        setConnectionState('reconnecting');
        scheduleRetry();
      }
    }).catch((error: unknown) => {
      markUnavailable(error instanceof Error ? error.message : 'collab_session_unavailable');
    });

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (window.__marklabNativeApplyDiskMarkdown) {
        delete window.__marklabNativeApplyDiskMarkdown;
      }
      if (window.__marklabRunEditorCommand) {
        delete window.__marklabRunEditorCommand;
      }
      if (window.__marklabSetNativeEditable) {
        delete window.__marklabSetNativeEditable;
      }
      binding?.destroy();
      view?.destroy();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __marklabEditorView?: EditorView }).__marklabEditorView;
      }
      provider?.destroy();
      persistence?.destroy();
      awareness?.destroy();
      ydoc.destroy();
    };
  }, [branchId, client, displayName, docId, token]);

  const usesMarkEditNativeShell = nativeShell === 'markedit';

  return (
    <main className={`collab-shell${usesMarkEditNativeShell ? ' markedit-native-shell' : ''}`}>
      {!usesMarkEditNativeShell ? (
        <header className="collab-topbar">
          <div>
            <h1>MarkLab</h1>
            <p>Edit session</p>
          </div>
          <span className={`connection-pill ${connectionState}`}>{connectionLabel(connectionState)}</span>
        </header>
      ) : null}
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
        {!usesMarkEditNativeShell ? (
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
            <div className="markdown-rendered-view">{renderMarkdownSnapshot(markdownPreview)}</div>
          </aside>
        ) : null}
      </section>
    </main>
  );
}
