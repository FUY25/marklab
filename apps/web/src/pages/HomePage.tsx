import { type FormEvent, useMemo, useRef, useState } from 'react';
import { KeyRound, Plus, Upload, X } from 'lucide-react';
import { MarklabWebApi, type CreatedDocument } from '../lib/api-client';
import { loadRecentDocuments, rememberRecentDocument, type RecentDocument } from '../lib/recent-documents';
import { clearSessionAdminToken, readSessionAdminToken, writeSessionAdminToken } from '../lib/session-auth';
import { buildDocumentPath } from '../routes';

function openDocument(docId: string, branchId: string) {
  window.location.assign(buildDocumentPath(docId, branchId));
}

function rememberAndOpen(document: CreatedDocument, title: string) {
  rememberRecentDocument({
    docId: document.docId,
    branchId: document.branchId,
    title,
  });
  openDocument(document.docId, document.branchId);
}

export function HomePage() {
  const api = useMemo(() => new MarklabWebApi(), []);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [adminToken, setAdminToken] = useState(() => readSessionAdminToken() ?? '');
  const [adminTokenSaved, setAdminTokenSaved] = useState(() => Boolean(readSessionAdminToken()));
  const [isAdminTokenOpen, setIsAdminTokenOpen] = useState(() => !readSessionAdminToken());
  const [adminStatus, setAdminStatus] = useState<string | null>(null);
  const [recentDocuments] = useState<RecentDocument[]>(() => loadRecentDocuments());
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'create' | 'import' | null>(null);

  function readableActionError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : fallback;
    if (message.includes(':403:')) {
      setIsAdminTokenOpen(true);
      return 'Admin token required. Open the key control and save a token.';
    }
    return message;
  }

  async function handleCreate() {
    const title = 'Untitled document';
    setBusyAction('create');
    setError(null);
    try {
      const document = await api.createBlankDoc(title);
      rememberAndOpen(document, title);
    } catch (createError) {
      setError(readableActionError(createError, 'Unable to create document.'));
      setBusyAction(null);
    }
  }

  async function handleImport(file: File | undefined) {
    if (!file) return;

    const normalizedTitle = file.name.replace(/\.md$/iu, '').trim() || 'Imported document';
    setBusyAction('import');
    setError(null);

    try {
      const markdown = await file.text();
      const document = await api.importMarkdown(normalizedTitle, markdown);
      rememberAndOpen(document, normalizedTitle);
    } catch (importError) {
      setError(readableActionError(importError, 'Unable to import Markdown.'));
      setBusyAction(null);
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }

  function handleSaveAdminToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedToken = adminToken.trim();
    if (!normalizedToken) {
      clearSessionAdminToken();
      setAdminToken('');
      setAdminTokenSaved(false);
      setAdminStatus('Admin token cleared.');
      return;
    }

    writeSessionAdminToken(normalizedToken);
    setAdminToken(normalizedToken);
    setAdminTokenSaved(true);
    setAdminStatus('Admin token saved for this browser session.');
    setIsAdminTokenOpen(false);
  }

  function handleClearAdminToken() {
    clearSessionAdminToken();
    setAdminToken('');
    setAdminTokenSaved(false);
    setAdminStatus('Admin token cleared.');
  }

  return (
    <main className="workspace-shell workspace-shell-simple" data-testid="home-page">
      <header className="workspace-header workspace-header-simple">
        <div>
          <p className="workspace-kicker">Cloud Markdown workspace</p>
          <h1>MarkLab</h1>
        </div>
      </header>

      <nav className="home-action-rail" aria-label="Workspace actions">
        <button
          type="button"
          className="home-action-button"
          aria-label="New document"
          title="New document"
          disabled={busyAction !== null}
          onClick={() => void handleCreate()}
        >
          <Plus className="home-action-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="home-action-button"
          aria-label="Import Markdown"
          title="Import Markdown"
          disabled={busyAction !== null}
          onClick={() => importInputRef.current?.click()}
        >
          <Upload className="home-action-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={isAdminTokenOpen ? 'home-action-button home-action-button-active' : 'home-action-button'}
          aria-label="Admin settings"
          aria-pressed={isAdminTokenOpen}
          title="Admin settings"
          onClick={() => setIsAdminTokenOpen((current) => !current)}
        >
          <KeyRound className="home-action-icon" aria-hidden="true" />
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          aria-label="Import Markdown file"
          className="home-hidden-file-input"
          disabled={busyAction !== null}
          onChange={(event) => void handleImport(event.currentTarget.files?.[0])}
        />
      </nav>

      {error ? (
        <div className="workspace-alert" role="alert">
          {error}
        </div>
      ) : null}

      {isAdminTokenOpen ? (
        <form className="admin-token-panel admin-token-panel-compact" aria-label="Admin session token" onSubmit={handleSaveAdminToken}>
          <div className="document-drawer-section-heading">
            <span>Admin token</span>
            <button type="button" aria-label="Close admin settings" title="Close admin settings" onClick={() => setIsAdminTokenOpen(false)}>
              <X className="document-action-rail-icon" aria-hidden="true" />
            </button>
          </div>
          <div className="field-stack">
            <label htmlFor="admin-token">Admin token</label>
            <input
              id="admin-token"
              type="password"
              value={adminToken}
              onChange={(event) => {
                setAdminToken(event.currentTarget.value);
                setAdminStatus(null);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="action-row">
            <button type="submit" disabled={busyAction !== null}>
              Save admin token
            </button>
            <button type="button" className="button-secondary" onClick={handleClearAdminToken} disabled={!adminTokenSaved && !adminToken}>
              Clear
            </button>
            <span role="status">{adminStatus}</span>
          </div>
        </form>
      ) : null}

      <section className="recent-documents recent-documents-simple" aria-label="Recent documents">
        <div className="section-heading">
          <h2>Recent documents</h2>
          <span>{recentDocuments.length}</span>
        </div>
        {recentDocuments.length > 0 ? (
          <ul>
            {recentDocuments.map((document) => (
              <li key={`${document.docId}:${document.branchId}`}>
                <button
                  type="button"
                  onClick={() => {
                    rememberRecentDocument(document);
                    openDocument(document.docId, document.branchId);
                  }}
                >
                  <span>{document.title}</span>
                  <code>{document.docId}</code>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No recent cloud documents in this browser.</p>
        )}
      </section>
    </main>
  );
}
