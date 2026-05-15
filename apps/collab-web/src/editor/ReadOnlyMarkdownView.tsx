import { useEffect, useMemo, useState } from 'react';
import {
  createCollabSessionClient,
  type CollabSession,
  type CollabSessionRequest,
  type ViewCollabSession,
} from '@marklab/collab-editor';
import { renderMarkdownSnapshot } from './markdown-render';

export interface ReadOnlyMarkdownSessionClient {
  createSession(request: CollabSessionRequest): Promise<CollabSession>;
}

export interface ReadOnlyMarkdownViewProps {
  docId: string;
  branchId: string;
  token?: string | undefined;
  displayName?: string | undefined;
  client?: ReadOnlyMarkdownSessionClient | undefined;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: ViewCollabSession }
  | { kind: 'unavailable'; reason: string };

export function ReadOnlyMarkdownView({
  docId,
  branchId,
  token,
  displayName = 'Guest',
  client: injectedClient,
}: ReadOnlyMarkdownViewProps) {
  const defaultClient = useMemo(() => createCollabSessionClient(), []);
  const client = injectedClient ?? defaultClient;
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  useEffect(() => {
    if (!docId || !branchId) {
      setState({ kind: 'unavailable', reason: 'missing_document_route' });
      return;
    }

    let disposed = false;
    setState({ kind: 'loading' });

    void client.createSession({
      docId,
      branchId,
      mode: 'view',
      displayName,
      token,
    }).then((session) => {
      if (disposed) return;
      if (session.mode !== 'view') {
        setState({ kind: 'unavailable', reason: 'invalid_view_session_response' });
        return;
      }
      setState({ kind: 'ready', session });
    }).catch((error: unknown) => {
      if (disposed) return;
      setState({ kind: 'unavailable', reason: error instanceof Error ? error.message : 'view_session_unavailable' });
    });

    return () => {
      disposed = true;
    };
  }, [branchId, client, displayName, docId, token]);

  return (
    <main className="view-shell">
      <header className="collab-topbar">
        <div>
          <h1>MarkLab</h1>
          <p>View session</p>
        </div>
        {state.kind === 'ready' ? (
          <span className="connection-pill connected">View only</span>
        ) : null}
      </header>
      <article
        className="markdown-document"
        data-doc-id={docId}
        data-branch-id={branchId}
        aria-busy={state.kind === 'loading'}
      >
        {state.kind === 'loading' ? <h2>Loading document</h2> : null}
        {state.kind === 'unavailable' ? (
          <section className="unavailable-banner" role="status">{state.reason}</section>
        ) : null}
        {state.kind === 'ready' ? (
          <>
            <div className="markdown-document-meta">
              {state.session.document.versionNumber === null
                ? state.session.document.hash
                : `Version ${state.session.document.versionNumber} · ${state.session.document.hash}`}
            </div>
            <div className="markdown-rendered-view">{renderMarkdownSnapshot(state.session.document.markdown)}</div>
          </>
        ) : null}
      </article>
    </main>
  );
}
