import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  MarklabWebApi,
  type VersionDetail,
  type VersionOperation,
  type VersionSummary,
} from '../lib/api-client';
import { buildDocumentPath } from '../routes';

interface VersionHistoryPanelProps {
  docId: string;
  branchId: string;
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function shortHash(hash: string): string {
  return hash.replace(/^sha256:/u, '').slice(0, 8) || hash.slice(0, 8);
}

function operationLabel(operation: VersionOperation): string {
  return operation.replace(/_/gu, ' ');
}

export function VersionHistoryPanel({ docId, branchId }: VersionHistoryPanelProps) {
  const api = useMemo(() => new MarklabWebApi(), []);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<VersionDetail | null>(null);
  const [branchName, setBranchName] = useState('');
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'status' | 'alert'>('status');
  const [isLoadingVersions, setIsLoadingVersions] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [busyAction, setBusyAction] = useState<'branch' | 'restore' | null>(null);

  async function refreshVersions(nextSelectedVersionId?: string) {
    setIsLoadingVersions(true);
    const response = await api.listVersions(docId, branchId);
    setVersions(response.versions);
    setSelectedVersionId(nextSelectedVersionId ?? response.versions[0]?.versionId ?? null);
    setIsLoadingVersions(false);
  }

  useEffect(() => {
    let isActive = true;
    setVersions([]);
    setSelectedVersionId(null);
    setSelectedVersion(null);
    setStatus(null);
    setBranchName('');
    setRestoreConfirmation('');
    setIsLoadingVersions(true);

    void api
      .listVersions(docId, branchId)
      .then((response) => {
        if (!isActive) return;
        setVersions(response.versions);
        setSelectedVersionId(response.versions[0]?.versionId ?? null);
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        setStatusKind('alert');
        setStatus(error instanceof Error ? error.message : 'Unable to load versions.');
      })
      .finally(() => {
        if (isActive) setIsLoadingVersions(false);
      });

    return () => {
      isActive = false;
    };
  }, [api, branchId, docId]);

  useEffect(() => {
    if (!selectedVersionId) {
      setSelectedVersion(null);
      return;
    }

    let isActive = true;
    setSelectedVersion(null);
    setRestoreConfirmation('');
    setIsLoadingDetail(true);

    void api
      .showVersion(docId, selectedVersionId)
      .then((version) => {
        if (isActive) setSelectedVersion(version);
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        setStatusKind('alert');
        setStatus(error instanceof Error ? error.message : 'Unable to load version preview.');
      })
      .finally(() => {
        if (isActive) setIsLoadingDetail(false);
      });

    return () => {
      isActive = false;
    };
  }, [api, docId, selectedVersionId]);

  async function handleBranchFromVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVersion) return;

    const normalizedName = branchName.trim();
    if (!normalizedName) {
      setStatusKind('alert');
      setStatus('Branch name is required.');
      return;
    }

    setBusyAction('branch');
    setStatus(null);
    try {
      const branch = await api.branchFromVersion(docId, selectedVersion.versionId, normalizedName);
      window.location.assign(buildDocumentPath(docId, branch.branchId));
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? error.message : 'Unable to branch from this version.');
      setBusyAction(null);
    }
  }

  async function handleRestoreVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVersion || restoreConfirmation !== 'RESTORE') return;

    setBusyAction('restore');
    setStatus(null);
    try {
      const restored = await api.restoreVersion(docId, branchId, selectedVersion.versionId);
      await refreshVersions(restored.versionId);
      setStatusKind('status');
      setStatus(`Restored as v${restored.versionNumber}.`);
      setRestoreConfirmation('');
      window.location.assign(buildDocumentPath(docId, branchId));
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? error.message : 'Unable to restore this version.');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <aside className="version-history-panel" data-testid="version-history-panel" aria-label="Version history">
      <div className="version-panel-heading">
        <div>
          <p className="workspace-kicker">History</p>
          <h2>Versions</h2>
        </div>
        <span>{isLoadingVersions ? 'Loading' : `${versions.length}`}</span>
      </div>

      <div className="version-list" aria-label="Branch versions">
        {versions.map((version) => (
          <button
            key={version.versionId}
            type="button"
            className={version.versionId === selectedVersionId ? 'version-row version-row-active' : 'version-row'}
            data-testid={`version-row-${version.versionNumber}`}
            onClick={() => setSelectedVersionId(version.versionId)}
          >
            <span className="version-row-main">
              <strong>v{version.versionNumber}</strong>
              <span>{operationLabel(version.operation)}</span>
            </span>
            <span className="version-row-meta">
              <span>{version.actorType}</span>
              <time dateTime={version.createdAt}>{formatCreatedAt(version.createdAt)}</time>
              <code>{shortHash(version.hash)}</code>
            </span>
          </button>
        ))}
        {!isLoadingVersions && versions.length === 0 ? <p className="version-empty">No versions on this branch.</p> : null}
      </div>

      <div className="version-detail">
        <div className="version-detail-title">
          <h3>{selectedVersion ? `v${selectedVersion.versionNumber} preview` : 'Preview'}</h3>
          <span>{isLoadingDetail ? 'Loading...' : selectedVersion ? operationLabel(selectedVersion.operation) : 'No version'}</span>
        </div>
        <pre className="version-preview" data-testid="version-preview">
          {selectedVersion?.markdown ?? ''}
        </pre>
      </div>

      <form className="version-action" onSubmit={handleBranchFromVersion}>
        <label htmlFor="new-branch-name">New branch name</label>
        <div className="version-action-row">
          <input
            id="new-branch-name"
            type="text"
            value={branchName}
            onChange={(event) => setBranchName(event.currentTarget.value)}
            disabled={!selectedVersion || busyAction !== null}
            autoComplete="off"
          />
          <button type="submit" disabled={!selectedVersion || busyAction !== null}>
            {busyAction === 'branch' ? 'Branching...' : 'Branch from this version'}
          </button>
        </div>
      </form>

      <form className="version-action version-action-danger" onSubmit={handleRestoreVersion}>
        <label htmlFor="restore-confirmation">Type RESTORE to confirm</label>
        <div className="version-action-row">
          <input
            id="restore-confirmation"
            type="text"
            value={restoreConfirmation}
            onChange={(event) => setRestoreConfirmation(event.currentTarget.value)}
            disabled={!selectedVersion || busyAction !== null}
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={!selectedVersion || restoreConfirmation !== 'RESTORE' || busyAction !== null}
          >
            {busyAction === 'restore' ? 'Restoring...' : 'Restore this version'}
          </button>
        </div>
      </form>

      <span className="version-panel-status" role={statusKind}>
        {status}
      </span>
    </aside>
  );
}
