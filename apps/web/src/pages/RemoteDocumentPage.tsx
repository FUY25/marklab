import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WebSocketStatus, type onStatusParameters } from '@hocuspocus/provider';
import { DocumentActionRail, type DocumentDrawerKind } from '../components/DocumentActionRail';
import { MilkdownEditor } from '../components/MilkdownEditor';
import { ReadOnlyMarkdownView } from '../components/ReadOnlyMarkdownView';
import { ShareDrawer } from '../components/ShareDrawer';
import { VersionsDrawer } from '../components/VersionsDrawer';
import { readWebConfig } from '../config';
import { type BranchSummaryResponse, MarklabWebApi, type ReadDocumentResponse } from '../lib/api-client';
import {
  readOrCreateAccessClientId,
  readStoredCollaboratorName,
  storeCollaboratorName,
} from '../lib/access-session';
import { createEditorCollab } from '../lib/editor-collab';
import { buildBranchRoomName } from '../lib/remote-room';
import { loadRecentDocuments, rememberRecentDocument } from '../lib/recent-documents';
import { readSessionAdminToken } from '../lib/session-auth';

interface RemoteDocumentPageProps {
  docId: string;
  branchId: string;
}

type EditorCollab = ReturnType<typeof createEditorCollab>;
type DocumentAccessMode = 'checking' | 'editable' | 'read-only';
type IdentityStatus = 'checking' | 'prompt' | 'ready';

interface CollaborationIdentity {
  scope: string;
  name: string;
  color?: string;
}

function readDocumentToken(): string | null {
  const token = new URLSearchParams(window.location.search).get('token');
  return token && token.trim() ? token : null;
}

function readableError(error: unknown, fallback: string): string {
  console.error(fallback, error);
  return fallback;
}

function collaboratorScope(docId: string, access: BranchSummaryResponse['access']): string {
  return access.grantId ? `grant.${access.grantId}` : `owner.${docId}`;
}

function ownerGuestName(): string {
  return 'Guest';
}

interface CollaborationNameDialogProps {
  busy: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}

function CollaborationNameDialog({ busy, error, onSubmit }: CollaborationNameDialogProps) {
  const [name, setName] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(name);
  }

  return (
    <div className="collaboration-name-layer">
      <section
        className="collaboration-name-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-name-title"
      >
        <h2 id="collaboration-name-title">Name for collaboration</h2>
        <p>This is how others will see your cursor.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="collaboration-name-input">Collaborator name</label>
          <input
            id="collaboration-name-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            disabled={busy}
            autoComplete="name"
            autoFocus
          />
          <div className="collaboration-name-actions">
            <button type="submit" disabled={busy}>
              Continue
            </button>
            <button type="button" disabled={busy} onClick={() => onSubmit('')}>
              Continue as Guest
            </button>
          </div>
        </form>
        {error ? (
          <p className="collaboration-name-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function RemoteDocumentPage({ docId, branchId }: RemoteDocumentPageProps) {
  const config = useMemo(() => readWebConfig(), []);
  const roomName = useMemo(() => buildBranchRoomName(docId, branchId), [branchId, docId]);
  const documentToken = useMemo(() => readDocumentToken(), []);
  const adminToken = useMemo(() => readSessionAdminToken(), []);
  const collabToken = documentToken ?? adminToken;
  const api = useMemo(() => new MarklabWebApi(documentToken ? { documentToken } : {}), [documentToken]);
  const [accessMode, setAccessMode] = useState<DocumentAccessMode>('checking');
  const [branchSummary, setBranchSummary] = useState<BranchSummaryResponse | null>(null);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>('checking');
  const [identity, setIdentity] = useState<CollaborationIdentity | null>(null);
  const [collab, setCollab] = useState<EditorCollab | null>(null);
  const [readOnlyDocument, setReadOnlyDocument] = useState<ReadDocumentResponse | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [isCreatingIdentity, setIsCreatingIdentity] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState<DocumentDrawerKind | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveStatusKind, setSaveStatusKind] = useState<'status' | 'alert'>('status');
  const autosaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let isActive = true;
    setAccessMode('checking');
    setBranchSummary(null);
    setConnectionMessage(null);
    setReadOnlyDocument(null);
    setIdentity(null);
    setIdentityStatus('checking');
    setActiveDrawer(null);

    void api
      .getBranchSummary(docId, branchId)
      .then((summary) => {
        if (!isActive) return;
        setBranchSummary(summary);
        setAccessMode(summary.access.canWrite ? 'editable' : 'read-only');
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        setAccessMode('read-only');
        setConnectionMessage(readableError(error, 'Unable to load document.'));
      });

    return () => {
      isActive = false;
    };
  }, [api, branchId, docId]);

  useEffect(() => {
    if (!branchSummary || !branchSummary.access.canWrite) return;
    const existingRecent = loadRecentDocuments().find((document) => document.docId === docId && document.branchId === branchId);
    const existingTitle = existingRecent?.title;
    rememberRecentDocument({
      docId,
      branchId,
      title: existingTitle && existingTitle !== docId ? existingTitle : branchSummary.title ?? docId,
    });
  }, [branchId, branchSummary, docId]);

  const establishIdentity = useCallback(
    async (displayName: string, source: 'prompt' | 'stored') => {
      if (!branchSummary || !branchSummary.access.canWrite) return;
      const scope = collaboratorScope(docId, branchSummary.access);
      const normalizedName = displayName.trim();
      setIsCreatingIdentity(true);
      setIdentityError(null);

      try {
        if (branchSummary.access.grantId) {
          const clientId = readOrCreateAccessClientId(docId, branchSummary.access.grantId);
          const session = await api.createAccessSession(docId, branchId, {
            clientId,
            clientKind: 'browser',
            displayName: normalizedName,
          });
          const identityName = source === 'stored' && normalizedName ? normalizedName : session.displayName;
          storeCollaboratorName(scope, identityName);
          setIdentity({ scope, name: identityName, color: session.color });
        } else {
          const identityName = normalizedName || ownerGuestName();
          storeCollaboratorName(scope, identityName);
          setIdentity({ scope, name: identityName });
        }
        setIdentityStatus('ready');
      } catch (error) {
        setIdentityStatus('prompt');
        setIdentityError(readableError(error, 'Unable to join collaboration.'));
      } finally {
        setIsCreatingIdentity(false);
      }
    },
    [api, branchId, branchSummary, docId],
  );

  useEffect(() => {
    if (accessMode !== 'editable' || !branchSummary) {
      setIdentityStatus(accessMode === 'read-only' ? 'ready' : 'checking');
      setIdentity(null);
      return;
    }

    const scope = collaboratorScope(docId, branchSummary.access);
    const storedName = readStoredCollaboratorName(scope);
    if (!storedName) {
      setIdentity(null);
      setIdentityStatus('prompt');
      return;
    }

    setIdentityStatus('checking');
    void establishIdentity(storedName, 'stored');
  }, [accessMode, branchSummary, docId, establishIdentity]);

  useEffect(() => {
    setConnectionMessage(null);
    setReadOnlyDocument(null);

    if (accessMode === 'checking') return undefined;

    if (accessMode === 'read-only') {
      let isActive = true;
      void api
        .readDocument(docId, branchId)
        .then((document) => {
          if (isActive) setReadOnlyDocument(document);
        })
        .catch((error: unknown) => {
          if (!isActive) return;
          setConnectionMessage(readableError(error, 'Unable to load document.'));
        });

      return () => {
        isActive = false;
      };
    }

    if (identityStatus !== 'ready' || !identity) return undefined;

    let nextCollab: EditorCollab;
    try {
      nextCollab = createEditorCollab({
        websocketUrl: config.websocketUrl,
        roomName,
        ...(collabToken ? { token: collabToken } : {}),
        user: {
          name: identity.name,
          ...(identity.color ? { color: identity.color } : {}),
        },
      });
    } catch (error) {
      setConnectionMessage(readableError(error, 'Connection lost'));
      return undefined;
    }

    const handleStatus = ({ status }: onStatusParameters) => {
      setConnectionMessage(status === WebSocketStatus.Disconnected ? 'Connection lost' : null);
    };
    const handleDisconnect = () => {
      setConnectionMessage('Connection lost');
    };
    const handleAuthenticated = () => {
      setConnectionMessage(null);
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
  }, [accessMode, api, branchId, collabToken, config.websocketUrl, docId, identity, identityStatus, roomName]);

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  const updateCollaboratorName = useCallback(
    async (nextName: string) => {
      if (!identity) return;
      const normalizedName = nextName.trim() || ownerGuestName();
      const currentUser = collab?.awareness.getLocalState()?.user as { color?: string } | undefined;
      let color = currentUser?.color ?? identity.color;
      const grantId = branchSummary?.access.grantId;

      if (grantId) {
        const clientId = readOrCreateAccessClientId(docId, grantId);
        const session = await api.createAccessSession(docId, branchId, {
          clientId,
          clientKind: 'browser',
          displayName: normalizedName,
        });
        color = session.color;
      }

      storeCollaboratorName(identity.scope, normalizedName);
      setIdentity({
        scope: identity.scope,
        name: normalizedName,
        ...(color ? { color } : {}),
      });
      collab?.awareness.setLocalStateField('user', {
        name: normalizedName,
        ...(color ? { color } : {}),
      });
    },
    [api, branchId, branchSummary?.access.grantId, collab, docId, identity],
  );

  const handleSaveStatusChange = useCallback((status: string, kind: 'status' | 'alert') => {
    setSaveStatus(status);
    setSaveStatusKind(kind);
  }, []);

  const handleMarkdownChange = useCallback(
    (markdown: string, previousMarkdown: string) => {
      if (markdown === previousMarkdown || accessMode !== 'editable') return;
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      setSaveStatusKind('status');
      setSaveStatus('Unsaved changes');
      autosaveTimerRef.current = window.setTimeout(() => {
        autosaveTimerRef.current = null;
        setSaveStatus('Saving');
        void api
          .autosaveVersion(docId, branchId)
          .then((saved) => {
            setSaveStatusKind('status');
            setSaveStatus(saved.created ? `Autosaved v${saved.versionNumber}` : 'Saved');
          })
          .catch((error: unknown) => {
            setSaveStatusKind('alert');
            setSaveStatus(readableError(error, 'Unable to autosave.'));
          });
      }, 900);
    },
    [accessMode, api, branchId, docId],
  );

  const isReadOnly = accessMode === 'read-only';
  const isEditableReady = accessMode === 'editable' && identityStatus === 'ready' && Boolean(identity);
  const canShowActions = isEditableReady && !isReadOnly;

  return (
    <main className="remote-document-shell" data-testid="remote-document-page">
      {connectionMessage ? <div className="remote-document-alert" role="alert">{connectionMessage}</div> : null}

      <section className="remote-document-canvas" aria-label={isReadOnly ? 'Read-only document' : 'Document editor'}>
        {isReadOnly && readOnlyDocument ? (
          <ReadOnlyMarkdownView markdown={readOnlyDocument.markdown} />
        ) : isReadOnly ? (
          <div className="read-only-document read-only-document-loading" data-testid="read-only-document" role="status">
            Loading document...
          </div>
        ) : accessMode === 'checking' || identityStatus === 'checking' ? (
          <div className="read-only-document read-only-document-loading" data-testid="document-access-check" role="status">
            Loading document...
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
        ) : null}
      </section>

      <DocumentActionRail
        hidden={!canShowActions}
        activeDrawer={activeDrawer}
        onToggleDrawer={(drawer) => setActiveDrawer((current) => (current === drawer ? null : drawer))}
      />

      {canShowActions ? (
        <>
          <VersionsDrawer
            docId={docId}
            branchId={branchId}
            open={activeDrawer === 'versions'}
            onClose={() => setActiveDrawer(null)}
            currentBranchLabel="Current document"
            canRestoreVersion={branchSummary?.access.canWrite ?? false}
            onSaveStatusChange={handleSaveStatusChange}
          />
          <ShareDrawer
            docId={docId}
            branchId={branchId}
            open={activeDrawer === 'share'}
            onClose={() => setActiveDrawer(null)}
            canManageAccess={branchSummary?.access.canManageAccess ?? false}
            showCollaboratorName={Boolean(identity)}
            collaboratorName={identity?.name ?? ''}
            onCollaboratorNameChange={updateCollaboratorName}
          />
        </>
      ) : null}

      {accessMode === 'editable' && identityStatus === 'prompt' ? (
        <CollaborationNameDialog
          busy={isCreatingIdentity}
          error={identityError}
          onSubmit={(name) => void establishIdentity(name, 'prompt')}
        />
      ) : null}

      {saveStatus ? (
        <div className="remote-save-status" role={saveStatusKind}>
          {saveStatus}
        </div>
      ) : null}
    </main>
  );
}
