import { useEffect, useMemo, useState } from 'react';
import { WebSocketStatus, type onStatusParameters } from '@hocuspocus/provider';
import { BranchSwitcher } from '../components/BranchSwitcher';
import { DocumentToolbar } from '../components/DocumentToolbar';
import { MilkdownEditor } from '../components/MilkdownEditor';
import { ShareAccessPanel } from '../components/ShareAccessPanel';
import { VersionHistoryPanel } from '../components/VersionHistoryPanel';
import { readWebConfig } from '../config';
import { MarklabWebApi, type ReadDocumentResponse } from '../lib/api-client';
import { createEditorCollab } from '../lib/editor-collab';
import { buildBranchRoomName } from '../lib/remote-room';
import { loadRecentDocuments, rememberRecentDocument } from '../lib/recent-documents';

interface RemoteDocumentPageProps {
  docId: string;
  branchId: string;
}

type EditorCollab = ReturnType<typeof createEditorCollab>;
type DocumentAccessMode = 'editable' | 'read-only';

function readDocumentToken(): string | null {
  const token = new URLSearchParams(window.location.search).get('token');
  return token && token.trim() ? token : null;
}

function readAccessMode(documentToken: string | null): DocumentAccessMode {
  if (!documentToken) return 'editable';
  const mode = new URLSearchParams(window.location.search).get('mode');
  return mode === 'edit' ? 'editable' : 'read-only';
}

export function RemoteDocumentPage({ docId, branchId }: RemoteDocumentPageProps) {
  const config = useMemo(() => readWebConfig(), []);
  const roomName = useMemo(() => buildBranchRoomName(docId, branchId), [branchId, docId]);
  const documentToken = useMemo(() => readDocumentToken(), []);
  const accessMode = useMemo(() => readAccessMode(documentToken), [documentToken]);
  const api = useMemo(() => new MarklabWebApi({ documentToken }), [documentToken]);
  const [collab, setCollab] = useState<EditorCollab | null>(null);
  const [readOnlyDocument, setReadOnlyDocument] = useState<ReadDocumentResponse | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);

  useEffect(() => {
    const existingRecent = loadRecentDocuments().find((document) => document.docId === docId && document.branchId === branchId);
    rememberRecentDocument({ docId, branchId, title: existingRecent?.title ?? docId });
  }, [branchId, docId]);

  useEffect(() => {
    setConnectionMessage(null);
    setReadOnlyDocument(null);

    if (accessMode === 'read-only') {
      let isActive = true;
      void api
        .readDocument(docId, branchId)
        .then((document) => {
          if (isActive) setReadOnlyDocument(document);
        })
        .catch((error: unknown) => {
          if (!isActive) return;
          setConnectionMessage(error instanceof Error ? error.message : 'Unable to load document.');
        });

      return () => {
        isActive = false;
      };
    }

    let nextCollab: EditorCollab;
    try {
      nextCollab = createEditorCollab({
        websocketUrl: config.websocketUrl,
        roomName,
        ...(documentToken ? { token: documentToken } : {}),
        user: { name: 'Human Writer', color: '#2563eb' },
      });
    } catch {
      setConnectionMessage('Connection lost');
      return;
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
  }, [accessMode, api, branchId, config.websocketUrl, docId, documentToken, roomName]);

  return (
    <main className="app-shell remote-document-shell" data-testid="remote-document-page">
      <header className="app-header">
        <div>
          <p className="workspace-kicker">Cloud document</p>
          <h1>MarkLab</h1>
        </div>
        <span className="document-id" data-testid="remote-document-id">
          {docId}
        </span>
      </header>
      <DocumentToolbar docId={docId} branchId={branchId} />
      {connectionMessage ? <div role="alert">{connectionMessage}</div> : null}
      <section className="remote-document-layout" aria-label="Document editor and history">
        <div className="remote-editor-workspace">
          {accessMode === 'read-only' ? (
            <article className="read-only-document" data-testid="read-only-document" aria-label="Read-only Markdown">
              <div className="read-only-heading">
                <p className="workspace-kicker">Read-only</p>
                <h2>Markdown</h2>
              </div>
              <pre>{readOnlyDocument?.markdown ?? 'Loading document...'}</pre>
            </article>
          ) : collab ? (
            <MilkdownEditor
              initialMarkdown=""
              ydoc={collab.ydoc}
              awareness={collab.awareness}
              applyInitialTemplate={false}
              testId="milkdown-editor"
            />
          ) : null}
        </div>
        <div className="remote-workbench">
          <BranchSwitcher docId={docId} branchId={branchId} />
          <ShareAccessPanel docId={docId} branchId={branchId} />
          <VersionHistoryPanel docId={docId} branchId={branchId} />
        </div>
      </section>
    </main>
  );
}
