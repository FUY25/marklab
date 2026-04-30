import { type FormEvent, useMemo, useState } from 'react';
import { MarklabWebApi, type CreatedDocument } from '../lib/api-client';
import { loadRecentDocuments, rememberRecentDocument, type RecentDocument } from '../lib/recent-documents';
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
  const [title, setTitle] = useState('Untitled document');
  const [docId, setDocId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>(() => loadRecentDocuments());
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'create' | 'import' | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setError('Document title is required.');
      return;
    }

    setBusyAction('create');
    setError(null);
    try {
      const document = await api.createBlankDoc(normalizedTitle);
      rememberAndOpen(document, normalizedTitle);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create document.');
      setBusyAction(null);
    }
  }

  async function handleImport(file: File | undefined) {
    if (!file) return;

    const normalizedTitle = title.trim() || file.name.replace(/\.md$/iu, '') || 'Imported document';
    setTitle(normalizedTitle);
    setBusyAction('import');
    setError(null);

    try {
      const markdown = await file.text();
      const document = await api.importMarkdown(normalizedTitle, markdown);
      rememberAndOpen(document, normalizedTitle);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Unable to import Markdown.');
      setBusyAction(null);
    }
  }

  function handleOpen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedDocId = docId.trim();
    const normalizedBranchId = branchId.trim();
    if (!normalizedDocId || !normalizedBranchId) {
      setError('Document id and Branch id are required.');
      return;
    }

    setError(null);
    const nextRecent = rememberRecentDocument({
      docId: normalizedDocId,
      branchId: normalizedBranchId,
      title: normalizedDocId,
    });
    setRecentDocuments(nextRecent);
    openDocument(normalizedDocId, normalizedBranchId);
  }

  return (
    <main className="workspace-shell" data-testid="home-page">
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">Cloud Markdown workspace</p>
          <h1>MarkLab</h1>
        </div>
      </header>

      {error ? (
        <div className="workspace-alert" role="alert">
          {error}
        </div>
      ) : null}

      <section className="workspace-grid" aria-label="Document actions">
        <form className="workspace-panel workspace-panel-primary" onSubmit={handleCreate}>
          <div className="field-stack">
            <label htmlFor="document-title">Document title</label>
            <input
              id="document-title"
              name="document-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="action-row">
            <button type="submit" disabled={busyAction !== null}>
              {busyAction === 'create' ? 'Creating...' : 'New Markdown Doc'}
            </button>
            <label className="file-button">
              Import Markdown
              <input
                type="file"
                accept=".md,text/markdown,text/plain"
                aria-label="Import Markdown"
                disabled={busyAction !== null}
                onChange={(event) => void handleImport(event.currentTarget.files?.[0])}
              />
            </label>
          </div>
        </form>

        <form className="workspace-panel" aria-label="Open document" onSubmit={handleOpen}>
          <div className="field-stack">
            <label htmlFor="document-id">Document id</label>
            <input
              id="document-id"
              type="text"
              value={docId}
              onChange={(event) => setDocId(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field-stack">
            <label htmlFor="branch-id">Branch id</label>
            <input
              id="branch-id"
              type="text"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              autoComplete="off"
            />
          </div>
          <button type="submit">Open</button>
        </form>
      </section>

      <section className="recent-documents" aria-label="Recent documents">
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
                  <code>{document.branchId}</code>
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
