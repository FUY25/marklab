import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WebSocketStatus, type onStatusParameters } from '@hocuspocus/provider';
import { X } from 'lucide-react';
import { ConflictReviewDrawer } from '../components/ConflictReviewDrawer';
import { DocumentActionRail, type DocumentDrawerKind } from '../components/DocumentActionRail';
import { MilkdownEditor } from '../components/MilkdownEditor';
import { ShareDrawer, type AccessGrantApi, type AccessGrantsResponse } from '../components/ShareDrawer';
import { readWebConfig } from '../config';
import {
  MarklabWebApi,
  readLocalDaemonToken,
  type ConflictResolutionResponse,
  type LocalDocumentResponse,
  type LocalVersionDetail,
  type LocalVersionSummary,
  type ReconnectConflict,
} from '../lib/api-client';
import { createEditorCollab } from '../lib/editor-collab';

type EditorCollab = ReturnType<typeof createEditorCollab>;

interface LocalDocumentIssue {
  conflict: string | null;
  historyLoadError: string | null;
}

interface LocalVersionsDrawerProps {
  api: MarklabWebApi;
  open: boolean;
  onClose: () => void;
  onStatusChange: (status: string, kind: 'status' | 'alert') => void;
  disabledReason?: string | null;
}

function readableError(error: unknown, fallback: string): string {
  console.error(fallback, error);
  return fallback;
}

function formatVersionTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function localDocumentIssue(document: LocalDocumentResponse): LocalDocumentIssue {
  return {
    conflict: document.conflict,
    historyLoadError: document.historyLoadError,
  };
}

function isSameDocumentIssue(current: LocalDocumentIssue, next: LocalDocumentIssue): boolean {
  return current.conflict === next.conflict && current.historyLoadError === next.historyLoadError;
}

function hasSameCollabIdentity(current: LocalDocumentResponse | null, next: LocalDocumentResponse): boolean {
  return current?.localDocId === next.localDocId && current.roomName === next.roomName;
}

function LocalVersionsDrawer({ api, open, onClose, onStatusChange, disabledReason = null }: LocalVersionsDrawerProps) {
  const [versions, setVersions] = useState<LocalVersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<LocalVersionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedVersion = versions.find((version) => version.versionId === selectedVersionId) ?? null;

  const refreshVersions = useCallback(async () => {
    const response = await api.listLocalVersions();
    setVersions(response.versions);
    setSelectedVersionId((current) => current ?? response.versions[0]?.versionId ?? null);
  }, [api]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refreshVersions().catch((refreshError: unknown) => {
      setError(readableError(refreshError, 'Unable to load versions.'));
    });
  }, [open, refreshVersions]);

  useEffect(() => {
    if (!open || !selectedVersionId) {
      setPreview(null);
      return;
    }

    let isActive = true;
    setError(null);
    void api
      .showLocalVersion(selectedVersionId)
      .then((version) => {
        if (isActive) setPreview(version);
      })
      .catch((previewError: unknown) => {
        if (isActive) setError(readableError(previewError, 'Unable to load version preview.'));
      });

    return () => {
      isActive = false;
    };
  }, [api, open, selectedVersionId]);

  async function handleManualSave() {
    if (disabledReason) {
      setError(disabledReason);
      onStatusChange(disabledReason, 'alert');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.manualSaveLocalVersion();
      await refreshVersions();
      setSelectedVersionId(saved.versionId);
      onStatusChange(saved.created ? `Saved snapshot v${saved.versionNumber}` : 'No changes to snapshot', 'status');
    } catch (saveError) {
      const message = readableError(saveError, 'Unable to save snapshot.');
      setError(message);
      onStatusChange(message, 'alert');
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!selectedVersionId) return;
    if (disabledReason) {
      setError(disabledReason);
      onStatusChange(disabledReason, 'alert');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const restored = await api.restoreLocalVersion(selectedVersionId);
      await refreshVersions();
      onStatusChange(`Restored snapshot v${restored.versionNumber}`, 'status');
    } catch (restoreError) {
      const message = readableError(restoreError, 'Unable to restore snapshot.');
      setError(message);
      onStatusChange(message, 'alert');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="document-drawer-layer">
      <aside className="document-drawer" aria-label="Local versions">
        <header className="document-drawer-header">
          <h2>Versions</h2>
          <button type="button" className="document-drawer-close" aria-label="Close versions" onClick={onClose}>
            <X className="document-drawer-close-icon" aria-hidden="true" />
          </button>
        </header>
        <div className="document-drawer-body">
          <section className="document-drawer-section">
            <div className="document-drawer-action-row">
              <button type="button" onClick={() => void handleManualSave()} disabled={busy || Boolean(disabledReason)}>
                Save snapshot
              </button>
              <button type="button" onClick={() => void handleRestore()} disabled={busy || Boolean(disabledReason) || !selectedVersion}>
                Restore
              </button>
            </div>
            {disabledReason ? <p className="versions-drawer-empty">{disabledReason}</p> : null}
            {error ? (
              <p className="document-drawer-status" role="alert">
                {error}
              </p>
            ) : null}
          </section>

          <section className="document-drawer-section">
            {versions.length > 0 ? (
              <ul className="versions-drawer-list">
                {versions.map((version) => {
                  const isActive = version.versionId === selectedVersionId;
                  return (
                    <li key={version.versionId}>
                      <button
                        type="button"
                        className={isActive ? 'versions-drawer-row versions-drawer-row-active' : 'versions-drawer-row'}
                        onClick={() => setSelectedVersionId(version.versionId)}
                      >
                        <span className="versions-drawer-row-main">
                          <strong>v{version.versionNumber}</strong>
                          <span>{version.operation.replace('_', ' ')}</span>
                        </span>
                        <span className="versions-drawer-row-meta">
                          <time dateTime={version.createdAt}>{formatVersionTime(version.createdAt)}</time>
                          <code>{version.hash.slice(0, 8)}</code>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="versions-drawer-empty">No snapshots yet.</p>
            )}
          </section>

          {preview ? (
            <section className="document-drawer-section">
              <pre className="versions-drawer-preview">{preview.markdown}</pre>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

export function LocalDocumentPage() {
  const config = useMemo(() => readWebConfig(), []);
  const [localDaemonToken, setLocalDaemonToken] = useState<string | null>(() => readLocalDaemonToken());
  const api = useMemo(() => new MarklabWebApi({ localDaemonToken }), [localDaemonToken]);
  const [document, setDocument] = useState<LocalDocumentResponse | null>(null);
  const [documentIssue, setDocumentIssue] = useState<LocalDocumentIssue>({ conflict: null, historyLoadError: null });
  const [currentConflict, setCurrentConflict] = useState<ReconnectConflict | null>(null);
  const [conflictDrawerOpen, setConflictDrawerOpen] = useState(false);
  const [closedConflictId, setClosedConflictId] = useState<string | null>(null);
  const [collab, setCollab] = useState<EditorCollab | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<DocumentDrawerKind | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'status' | 'alert'>('status');
  const flushTimerRef = useRef<number | null>(null);
  const documentIssueRef = useRef<LocalDocumentIssue>({ conflict: null, historyLoadError: null });
  const currentConflictRef = useRef<ReconnectConflict | null>(null);
  const localDocId = document?.localDocId ?? null;
  const roomName = document?.roomName ?? null;
  const conflictOpen = Boolean(documentIssue.conflict || currentConflict?.status === 'open');
  const localPauseReason = 'Sync paused. Resolve the conflict before saving or restoring snapshots.';
  const localRelayAccessApi = useMemo<AccessGrantApi>(() => {
    function toAccessGrantsResponse(state: Awaited<ReturnType<MarklabWebApi['getLocalShareState']>>): AccessGrantsResponse {
      return {
        grants: state.links
          .filter((link) => !link.revokedAt)
          .map((link) => ({
            grantId: link.grantId,
            role: link.role,
            branchId: state.relayRoomId ?? 'relay',
            branchName: link.role === 'edit' ? 'Relay edit link' : 'Relay view link',
            expiresAt: link.expiresAt,
            revokedAt: link.revokedAt,
            createdAt: link.createdAt,
            sessions: state.sessions
              .filter((session) => session.grantId === link.grantId)
              .map((session) => ({
                sessionId: session.sessionId,
                clientKind: session.clientKind === 'daemon' ? 'daemon' : session.clientKind === 'agent' ? 'agent' : 'browser',
                displayName: session.displayName,
                color: '#64748b',
                lastBranchId: null,
                lastSeenAt: session.lastSeenAt,
                grantId: session.grantId,
                role: session.role,
              })),
          })),
        sessions: state.sessions.map((session) => ({
          sessionId: session.sessionId,
          clientKind: session.clientKind === 'daemon' ? 'daemon' : session.clientKind === 'agent' ? 'agent' : 'browser',
          displayName: session.displayName,
          color: '#64748b',
          lastBranchId: null,
          lastSeenAt: session.lastSeenAt,
          grantId: session.grantId,
          role: session.role,
        })),
      };
    }

    return {
      async createAccessGrant(_docId, _branchId, input) {
        const created = await api.createLocalRelayAccessGrant({ role: input.role });
        return {
          grantId: created.grantId,
          branchId: created.relayRoomId,
          token: created.token,
          role: created.role,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
          url: created.url,
        };
      },
      async listAccessGrants() {
        return toAccessGrantsResponse(await api.getLocalShareState());
      },
      async revokeAccessGrant(grantId) {
        await api.revokeLocalRelayAccessGrant(grantId);
      },
    };
  }, [api]);

  useEffect(() => {
    const refreshLocalDaemonToken = () => {
      const nextToken = readLocalDaemonToken();
      setLocalDaemonToken((currentToken) => (currentToken === nextToken ? currentToken : nextToken));
    };

    window.addEventListener('hashchange', refreshLocalDaemonToken);
    window.addEventListener('popstate', refreshLocalDaemonToken);
    return () => {
      window.removeEventListener('hashchange', refreshLocalDaemonToken);
      window.removeEventListener('popstate', refreshLocalDaemonToken);
    };
  }, []);

  const setSaveStatus = useCallback((nextStatus: string, nextKind: 'status' | 'alert' = 'status') => {
    setStatus(nextStatus);
    setStatusKind(nextKind);
  }, []);

  const applyCurrentConflict = useCallback(
    (nextConflict: ReconnectConflict | null) => {
      const openConflict = nextConflict?.status === 'open' ? nextConflict : null;
      currentConflictRef.current = openConflict;
      setCurrentConflict(openConflict);
      if (!openConflict) {
        setConflictDrawerOpen(false);
        setClosedConflictId(null);
        return;
      }
      if (openConflict.conflictId !== closedConflictId) setConflictDrawerOpen(true);
    },
    [closedConflictId],
  );

  const refreshCurrentConflict = useCallback(async () => {
    const response = await api.getCurrentLocalConflict();
    applyCurrentConflict(response.conflict);
    return response.conflict;
  }, [api, applyCurrentConflict]);

  const applyLocalDocumentState = useCallback((nextDocument: LocalDocumentResponse) => {
    const nextIssue = localDocumentIssue(nextDocument);
    documentIssueRef.current = nextIssue;
    setDocumentIssue((currentIssue) => (isSameDocumentIssue(currentIssue, nextIssue) ? currentIssue : nextIssue));
    setDocument((currentDocument) =>
      hasSameCollabIdentity(currentDocument, nextDocument) ? currentDocument : nextDocument,
    );
  }, []);

  useEffect(() => {
    let isActive = true;
    void api
      .getLocalDocument()
      .then((localDocument) => {
        if (isActive) applyLocalDocumentState(localDocument);
      })
      .catch((error: unknown) => {
        if (isActive) setSaveStatus(readableError(error, 'Open a Markdown file with marklab open README.md.'), 'alert');
      });

    return () => {
      isActive = false;
    };
  }, [api, applyLocalDocumentState, setSaveStatus]);

  useEffect(() => {
    if (documentIssue.conflict) {
      setSaveStatus('Sync paused', 'alert');
      return;
    }
    if (documentIssue.historyLoadError) {
      setSaveStatus('Local history could not be loaded.', 'alert');
    }
  }, [documentIssue, setSaveStatus]);

  useEffect(() => {
    if (!documentIssue.conflict) {
      applyCurrentConflict(null);
      return;
    }

    void refreshCurrentConflict().catch((error: unknown) => {
      setSaveStatus(readableError(error, 'Unable to load conflict review.'), 'alert');
    });
  }, [applyCurrentConflict, documentIssue.conflict, refreshCurrentConflict, setSaveStatus]);

  useEffect(() => {
    if (!roomName || conflictOpen) return undefined;

    let nextCollab: EditorCollab;
    try {
      nextCollab = createEditorCollab({
        websocketUrl: config.websocketUrl,
        roomName,
        ...(localDaemonToken ? { token: localDaemonToken } : {}),
        user: { name: 'Local writer' },
      });
    } catch (error) {
      setSaveStatus(readableError(error, 'Connection lost'), 'alert');
      return undefined;
    }

    const handleStatus = ({ status: connectionStatus }: onStatusParameters) => {
      if (connectionStatus === WebSocketStatus.Disconnected) {
        setSaveStatus('Connection lost', 'alert');
      }
    };
    const handleDisconnect = () => {
      setSaveStatus('Connection lost', 'alert');
    };
    const handleAuthenticated = () => {
      const currentIssue = documentIssueRef.current;
      if (currentIssue.conflict) {
        setSaveStatus(currentIssue.conflict, 'alert');
        return;
      }
      if (currentIssue.historyLoadError) {
        setSaveStatus('Local history could not be loaded.', 'alert');
        return;
      }
      setSaveStatus('Connected to local file', 'status');
    };

    nextCollab.provider.on('status', handleStatus);
    nextCollab.provider.on('disconnect', handleDisconnect);
    nextCollab.provider.on('authenticationFailed', handleDisconnect);
    nextCollab.provider.on('authenticated', handleAuthenticated);
    setCollab(nextCollab);

    return () => {
      nextCollab.provider.off('status', handleStatus);
      nextCollab.provider.off('disconnect', handleDisconnect);
      nextCollab.provider.off('authenticationFailed', handleDisconnect);
      nextCollab.provider.off('authenticated', handleAuthenticated);
      setCollab(null);
      nextCollab.destroy();
    };
  }, [config.websocketUrl, conflictOpen, localDaemonToken, localDocId, roomName, setSaveStatus]);

  useEffect(() => {
    if (!localDocId) return undefined;

    let isActive = true;
    const pollDocumentState = () => {
      void api
        .getLocalDocument()
        .then((nextDocument) => {
          if (!isActive) return;
          applyLocalDocumentState(nextDocument);
        })
        .catch(() => undefined);
    };

    const interval = window.setInterval(pollDocumentState, 1500);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [api, applyLocalDocumentState, localDocId]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    };
  }, []);

  const handleMarkdownChange = useCallback(
    (markdown: string, previousMarkdown: string) => {
      if (markdown === previousMarkdown) return;
      if (documentIssueRef.current.conflict || currentConflictRef.current) {
        if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        setSaveStatus('Sync paused. Resolve the conflict before editing this local file.', 'alert');
        return;
      }
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      setSaveStatus('Writing to file');
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        void api
          .flushLocalDocument()
          .then((nextDocument) => {
            applyLocalDocumentState(nextDocument);
            setSaveStatus(nextDocument.conflict ?? 'Saved to file', nextDocument.conflict ? 'alert' : 'status');
          })
          .catch((error: unknown) => {
            setSaveStatus(readableError(error, 'Unable to write file.'), 'alert');
          });
      }, 500);
    },
    [api, applyLocalDocumentState, setSaveStatus],
  );

  const handleConflictDrawerClose = useCallback(() => {
    if (currentConflictRef.current) setClosedConflictId(currentConflictRef.current.conflictId);
    setConflictDrawerOpen(false);
    setSaveStatus('Sync paused', 'alert');
  }, [setSaveStatus]);

  const handleConflictResolved = useCallback(
    async (_response: ConflictResolutionResponse) => {
      currentConflictRef.current = null;
      setCurrentConflict(null);
      setConflictDrawerOpen(false);
      setClosedConflictId(null);
      const nextDocument = await api.getLocalDocument();
      applyLocalDocumentState(nextDocument);
      await refreshCurrentConflict().catch(() => undefined);
      setSaveStatus('Conflict resolved. Sync resumed.', 'status');
    },
    [api, applyLocalDocumentState, refreshCurrentConflict, setSaveStatus],
  );

  return (
    <main className="remote-document-shell" data-testid="local-document-page">
      <section className="remote-document-canvas" aria-label="Local Markdown editor">
        {conflictOpen ? (
          <div className="local-conflict-paused" data-testid="local-conflict-paused" role="status">
            <h1>Sync paused</h1>
            <p>This file changed locally while the shared session also changed.</p>
            <p>Both original versions were snapshotted and remain recoverable.</p>
            {currentConflict ? (
              <button type="button" onClick={() => setConflictDrawerOpen(true)}>
                Review conflict
              </button>
            ) : (
              <p className="local-conflict-paused-detail">
                {documentIssue.conflict ?? 'Conflict review is loading.'}
              </p>
            )}
          </div>
        ) : collab ? (
          <MilkdownEditor
            initialMarkdown=""
            ydoc={collab.ydoc}
            awareness={collab.awareness}
            applyInitialTemplate={false}
            testId="milkdown-editor"
            onMarkdownChange={handleMarkdownChange}
          />
        ) : (
          <div className="read-only-document read-only-document-loading" role="status">
            {statusKind === 'alert' && status ? status : 'Loading local file...'}
          </div>
        )}
      </section>

      <DocumentActionRail
        hidden={!document}
        activeDrawer={activeDrawer}
        availableDrawers={['versions', 'share']}
        onToggleDrawer={(drawer) => setActiveDrawer((current) => (current === drawer ? null : drawer))}
      />

      <LocalVersionsDrawer
        api={api}
        open={activeDrawer === 'versions'}
        onClose={() => setActiveDrawer(null)}
        onStatusChange={setSaveStatus}
        disabledReason={conflictOpen ? localPauseReason : null}
      />

      {document ? (
        <ShareDrawer
          docId={document.localDocId}
          branchId={document.roomName}
          open={activeDrawer === 'share'}
          onClose={() => setActiveDrawer(null)}
          onStatusChange={setSaveStatus}
          accessApi={localRelayAccessApi}
        />
      ) : null}

      <ConflictReviewDrawer
        api={api}
        conflict={currentConflict}
        open={conflictDrawerOpen}
        onClose={handleConflictDrawerClose}
        onResolved={handleConflictResolved}
        onStatusChange={setSaveStatus}
      />

      {status ? (
        <div className="remote-save-status" role={statusKind}>
          {status}
        </div>
      ) : null}
    </main>
  );
}
