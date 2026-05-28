import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { EVENT_CONNECTION_STATUS, STATUS_CONNECTED, STATUS_CONNECTING, STATUS_ERROR, STATUS_OFFLINE } from '@y-sweet/client';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
  awarenessClientMeta,
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
import { markEditMarkdownEditorExtensions } from '@marklab/collab-editor/markedit-codemirror';
import {
  runMarkdownEditorCommand,
  type MarkdownEditorCommand,
} from '@marklab/collab-editor/markdown-commands';
import {
  clearPersistedEditSession,
  clearPersistedEditSessionAndCache,
  cleanupStalePersistedEditSessions,
  loadPersistedEditSession,
  persistEditSession,
  type PersistedEditSession,
} from '../api/edit-session-storage';
import { BrandLockup } from '../BrandLockup';
import { createMarkLabYjsProvider, type MarkLabYjsProvider } from '../provider/yjs-provider';
import { renderMarkdownSnapshot } from './markdown-render';
import {
  applyNativeDiskMarkdownToText,
  createNativeMarkdownSnapshotScheduler,
  type NativeMarkdownSnapshotScheduler,
  postNativeCollaborators,
  postNativeMarkdownSnapshot,
  postNativeSelectionStatus,
} from './native-bridge';

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

function selectionStatus(view: EditorView): string {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  const column = selection.head - line.from + 1;
  const selectedLength = Math.abs(selection.to - selection.from);
  const base = `Ln ${line.number}, Col ${column}`;
  return selectedLength > 0 ? `${base} (${selectedLength})` : base;
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

function CollaboratorPresence({ collaborators, native = false }: {
  collaborators: RemoteCursorSummary[];
  native?: boolean;
}) {
  if (collaborators.length === 0) return null;

  return (
    <div className={`presence-strip${native ? ' native-presence-strip' : ''}`} aria-label="Collaborators">
      {collaborators.map((collaborator) => (
        <span
          className="presence-chip"
          key={collaborator.clientId}
          style={{ '--presence-color': collaborator.color } as CSSProperties}
        >
          <span className="presence-dot" aria-hidden="true" />
          <span className="presence-name">{collaborator.name}</span>
        </span>
      ))}
    </div>
  );
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
    let nativeMarkdownSnapshotScheduler: NativeMarkdownSnapshotScheduler | null = null;
    let binding: YTextCodeMirrorBinding | null = null;
    let provider: MarkLabYjsProvider | null = null;
    let persistence: IndexeddbPersistence | null = null;
    let awareness: Awareness | null = null;
    let awarenessCleared = false;
    let hasExplicitLocalCursor = false;
    let unavailable = false;
    let nativeEditable = true;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    const editableCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    const providerTokenRef: { current: IssuedProviderToken | null } = { current: null };
    const activeSessionRef: { current: EditorSession | null } = { current: null };
    const storageKeyInput = { docId, branchId, token };
    if (clientKind !== 'app') cleanupStalePersistedEditSessions();

    function reconfigureEditability() {
      view?.dispatch({
        effects: [
          editableCompartment.reconfigure(EditorView.editable.of(!unavailable && nativeEditable)),
          readOnlyCompartment.reconfigure(EditorState.readOnly.of(unavailable || !nativeEditable)),
        ],
      });
    }

    function clearLocalAwareness() {
      if (!awareness || awarenessCleared) return;
      awarenessCleared = true;
      awareness.setLocalState(null);
      postNativeCollaborators([]);
    }

    function markUnavailable(reason: string) {
      if (disposed) return;
      unavailable = true;
      const activeSession = activeSessionRef.current;
      clearPersistedEditSessionAndCache(
        storageKeyInput,
        activeSession
          ? { session: { providerDocId: activeSession.providerDocId, sessionId: activeSession.sessionId } }
          : {},
      );
      clearLocalAwareness();
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
        clientKind,
      });
      awareness.setLocalStateField('user', localUser);
      const syncRemoteCursorSummaries = () => {
        if (!awareness) return;
        const summaries = summarizeRemoteCursors(
          awareness.getStates() as ReadonlyMap<number, MarkLabAwarenessState>,
          ydoc.clientID,
          { meta: awarenessClientMeta(awareness) },
        );
        setRemoteCursors(summaries);
        postNativeCollaborators(summaries);
      };
      awareness.on('change', syncRemoteCursorSummaries);
      syncRemoteCursorSummaries();
      persistence = new IndexeddbPersistence(
        createIndexedDbPersistenceKey(activeSession.providerDocId, activeSession.sessionId),
        ydoc,
      );
      const publishLocalCursor = (options: { activate: boolean }) => {
        if (!awareness || !view) return;
        postNativeSelectionStatus(selectionStatus(view));
        if (!view.hasFocus) {
          hasExplicitLocalCursor = false;
          awareness.setLocalStateField('cursor', null);
          return;
        }
        if (options.activate) hasExplicitLocalCursor = true;
        if (!hasExplicitLocalCursor) {
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
            ...markEditMarkdownEditorExtensions(),
            editableCompartment.of(EditorView.editable.of(nativeEditable)),
            readOnlyCompartment.of(EditorState.readOnly.of(!nativeEditable)),
            EditorState.transactionFilter.of((transaction) => {
              if ((unavailable || !nativeEditable) && transaction.docChanged && !transaction.annotation(ySyncAnnotation)) return [];
              return transaction;
            }),
            createRemoteCursorExtension({
              awareness,
              ytext,
              localClientId: ydoc.clientID,
              labelMode: 'transient',
              labelRenderer: nativeShell === 'markedit' ? 'none' : 'inline',
            }),
            EditorView.updateListener.of((update) => {
              const hasLocalDocChange = update.transactions.some((transaction) => (
                transaction.docChanged && !transaction.annotation(ySyncAnnotation)
              ));
              if (update.docChanged) {
                if (nativeMarkdownSnapshotScheduler) {
                  nativeMarkdownSnapshotScheduler.schedule();
                } else {
                  const markdown = update.state.doc.toString();
                  setMarkdownPreview(markdown);
                  postNativeMarkdownSnapshot(markdown);
                }
                queueMicrotask(() => {
                  if (!disposed) publishLocalCursor({ activate: hasLocalDocChange });
                });
              }
              if (!update.docChanged && update.selectionSet) publishLocalCursor({ activate: true });
              if (!update.docChanged && update.focusChanged && !update.view.hasFocus) {
                publishLocalCursor({ activate: false });
              }
            }),
          ],
        }),
      });
      nativeMarkdownSnapshotScheduler = nativeShell === 'markedit'
        ? createNativeMarkdownSnapshotScheduler({
          readMarkdown: () => view?.state.doc.toString() ?? '',
        })
        : null;
      postNativeSelectionStatus(selectionStatus(view));
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
      nativeMarkdownSnapshotScheduler?.cancel();
      binding?.destroy();
      view?.destroy();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __marklabEditorView?: EditorView }).__marklabEditorView;
      }
      clearLocalAwareness();
      provider?.destroy();
      persistence?.destroy();
      awareness?.destroy();
      ydoc.destroy();
    };
  }, [branchId, client, clientKind, displayName, docId, nativeShell, token]);

  const usesMarkEditNativeShell = nativeShell === 'markedit';

  return (
    <main className={`collab-shell${usesMarkEditNativeShell ? ' markedit-native-shell' : ''}`}>
      {!usesMarkEditNativeShell ? (
        <header className="collab-topbar">
          <BrandLockup title="MarkLab" subtitle="Edit session" />
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
        >
          <CollaboratorPresence collaborators={remoteCursors} native={usesMarkEditNativeShell} />
          <div className="codemirror-editor-host" ref={editorHostRef} />
        </div>
        {!usesMarkEditNativeShell ? (
          <aside className="preview-pane" aria-label="Live preview">
            <CollaboratorPresence collaborators={remoteCursors} />
            <div className="markdown-rendered-view">{renderMarkdownSnapshot(markdownPreview)}</div>
          </aside>
        ) : null}
      </section>
    </main>
  );
}
