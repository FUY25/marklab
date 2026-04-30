import { useEffect, useMemo, useState } from 'react';
import { WebSocketStatus, type onStatusParameters } from '@hocuspocus/provider';
import { BranchSwitcher } from '../components/BranchSwitcher';
import { DocumentToolbar } from '../components/DocumentToolbar';
import { MilkdownEditor } from '../components/MilkdownEditor';
import { VersionHistoryPanel } from '../components/VersionHistoryPanel';
import { readWebConfig } from '../config';
import { createEditorCollab } from '../lib/editor-collab';
import { buildBranchRoomName } from '../lib/remote-room';
import { loadRecentDocuments, rememberRecentDocument } from '../lib/recent-documents';

interface RemoteDocumentPageProps {
  docId: string;
  branchId: string;
}

type EditorCollab = ReturnType<typeof createEditorCollab>;

export function RemoteDocumentPage({ docId, branchId }: RemoteDocumentPageProps) {
  const config = useMemo(() => readWebConfig(), []);
  const roomName = useMemo(() => buildBranchRoomName(docId, branchId), [branchId, docId]);
  const [collab, setCollab] = useState<EditorCollab | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);

  useEffect(() => {
    const existingRecent = loadRecentDocuments().find((document) => document.docId === docId && document.branchId === branchId);
    rememberRecentDocument({ docId, branchId, title: existingRecent?.title ?? docId });
  }, [branchId, docId]);

  useEffect(() => {
    setConnectionMessage(null);

    let nextCollab: EditorCollab;
    try {
      nextCollab = createEditorCollab({
        websocketUrl: config.websocketUrl,
        roomName,
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
  }, [config.websocketUrl, roomName]);

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
          {collab ? (
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
          <VersionHistoryPanel docId={docId} branchId={branchId} />
        </div>
      </section>
    </main>
  );
}
