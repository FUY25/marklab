import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  MarklabWebApi,
  type BranchSummary,
  type VersionDetail,
  type VersionOperation,
  type VersionSummary,
} from '../lib/api-client';
import { buildDocumentPath } from '../routes';
import { DocumentDrawer } from './DocumentDrawer';

type SaveStatusKind = 'status' | 'alert';

interface VersionsDrawerProps {
  docId: string;
  branchId: string;
  open: boolean;
  onClose: () => void;
  currentBranchLabel?: string;
  canSwitchBranches?: boolean;
  canBranchFromVersion?: boolean;
  canRestoreVersion?: boolean;
  enableSaveShortcut?: boolean;
  onSaveStatusChange?: (status: string, kind: SaveStatusKind) => void;
  onNavigateToBranch?: (branchId: string) => void;
  onBackToDocuments?: () => void;
  api?: Pick<
    MarklabWebApi,
    | 'branchFromVersion'
    | 'exportMarkdown'
    | 'listBranches'
    | 'listVersions'
    | 'manualSaveVersion'
    | 'restoreVersion'
    | 'showVersion'
  >;
}

type BusyAction = 'branch' | 'export' | 'load-branches' | 'manual-save' | 'restore';

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

function branchLabel(branch: BranchSummary): string {
  const name = branch.slug || branch.name || branch.branchId;
  const suffix = branch.headVersionNumber ? `v${branch.headVersionNumber}` : 'no versions';
  return `${name}${branch.isArchived ? ' archived' : ''} (${suffix})`;
}

function readableVersionError(action: string): string {
  if (action === 'branches') return 'Unable to load branches.';
  if (action === 'detail') return 'Unable to load version preview.';
  if (action === 'export') return 'Unable to export Markdown.';
  if (action === 'manual-save') return 'Unable to save version.';
  if (action === 'restore') return 'Unable to restore this version.';
  if (action === 'branch') return 'Unable to branch from this version.';
  return 'Unable to load versions.';
}

function downloadMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function VersionsDrawer({
  docId,
  branchId,
  open,
  onClose,
  currentBranchLabel,
  canSwitchBranches = true,
  canBranchFromVersion = canSwitchBranches,
  canRestoreVersion = true,
  enableSaveShortcut = true,
  onSaveStatusChange,
  onNavigateToBranch,
  onBackToDocuments,
  api,
}: VersionsDrawerProps) {
  const marklabApi = useMemo(() => api ?? new MarklabWebApi(), [api]);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<VersionDetail | null>(null);
  const [newBranchName, setNewBranchName] = useState('');
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<SaveStatusKind>('status');
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);

  const setReadableStatus = useCallback(
    (nextStatus: string, kind: SaveStatusKind = 'status') => {
      setStatusKind(kind);
      setStatus(nextStatus);
      onSaveStatusChange?.(nextStatus, kind);
    },
    [onSaveStatusChange],
  );

  const refreshVersions = useCallback(
    async (nextSelectedVersionId?: string) => {
      setIsLoadingVersions(true);
      try {
        const response = await marklabApi.listVersions(docId, branchId);
        setVersions(response.versions);
        setSelectedVersionId(nextSelectedVersionId ?? response.versions[0]?.versionId ?? null);
      } catch (error) {
        console.error('Unable to load versions.', error);
        setReadableStatus(readableVersionError('versions'), 'alert');
      } finally {
        setIsLoadingVersions(false);
      }
    },
    [branchId, docId, marklabApi, setReadableStatus],
  );

  useEffect(() => {
    if (!open) return;
    setVersions([]);
    setSelectedVersionId(null);
    setSelectedVersion(null);
    setNewBranchName('');
    setRestoreConfirmation('');
    setStatus(null);
    void refreshVersions();
  }, [open, refreshVersions]);

  useEffect(() => {
    if (!open || !canSwitchBranches) return undefined;

    let isActive = true;
    setBusyAction('load-branches');
    void marklabApi
      .listBranches(docId)
      .then((response) => {
        if (isActive) setBranches(response.branches);
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        console.error('Unable to load branches.', error);
        setReadableStatus(readableVersionError('branches'), 'alert');
      })
      .finally(() => {
        if (isActive) setBusyAction((current) => (current === 'load-branches' ? null : current));
      });

    return () => {
      isActive = false;
    };
  }, [canSwitchBranches, docId, marklabApi, open, setReadableStatus]);

  useEffect(() => {
    if (!open || !selectedVersionId) {
      setSelectedVersion(null);
      return undefined;
    }

    let isActive = true;
    setSelectedVersion(null);
    setRestoreConfirmation('');
    setIsLoadingDetail(true);

    void marklabApi
      .showVersion(docId, selectedVersionId)
      .then((version) => {
        if (isActive) setSelectedVersion(version);
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        console.error('Unable to load version preview.', error);
        setReadableStatus(readableVersionError('detail'), 'alert');
      })
      .finally(() => {
        if (isActive) setIsLoadingDetail(false);
      });

    return () => {
      isActive = false;
    };
  }, [docId, marklabApi, open, selectedVersionId, setReadableStatus]);

  const handleManualSave = useCallback(async () => {
    if (busyAction === 'manual-save') return;

    setBusyAction('manual-save');
    setReadableStatus('Saving');
    try {
      const saved = await marklabApi.manualSaveVersion(docId, branchId);
      const nextStatus = saved.created ? `Manual saved v${saved.versionNumber}` : 'No changes to save';
      setReadableStatus(nextStatus);
      await refreshVersions(saved.versionId);
    } catch (error) {
      console.error('Unable to save version.', error);
      setReadableStatus(readableVersionError('manual-save'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }, [branchId, busyAction, docId, marklabApi, refreshVersions, setReadableStatus]);

  useEffect(() => {
    if (!enableSaveShortcut) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== 's' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      void handleManualSave();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enableSaveShortcut, handleManualSave]);

  function handleBranchChange(nextBranchId: string) {
    if (!nextBranchId || nextBranchId === branchId) return;
    if (onNavigateToBranch) {
      onNavigateToBranch(nextBranchId);
      return;
    }
    window.location.assign(buildDocumentPath(docId, nextBranchId));
  }

  async function handleExportMarkdown() {
    setBusyAction('export');
    setReadableStatus('Exporting');
    try {
      const exported = await marklabApi.exportMarkdown(docId, branchId);
      downloadMarkdown(exported.filename, exported.markdown);
      setReadableStatus(`Exported ${exported.filename}`);
    } catch (error) {
      console.error('Unable to export Markdown.', error);
      setReadableStatus(readableVersionError('export'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleBranchFromVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVersion || !canBranchFromVersion) return;

    const normalizedName = newBranchName.trim();
    if (!normalizedName) {
      setReadableStatus('Branch name is required.', 'alert');
      return;
    }

    setBusyAction('branch');
    setStatus(null);
    try {
      const branch = await marklabApi.branchFromVersion(docId, selectedVersion.versionId, normalizedName);
      handleBranchChange(branch.branchId);
    } catch (error) {
      console.error('Unable to branch from this version.', error);
      setReadableStatus(readableVersionError('branch'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRestoreVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVersion || !canRestoreVersion || restoreConfirmation !== 'RESTORE') return;
    if (selectedVersion.branchId !== branchId) {
      setReadableStatus('Only current-branch versions can be restored here.', 'alert');
      return;
    }

    setBusyAction('restore');
    setStatus(null);
    try {
      const restored = await marklabApi.restoreVersion(docId, branchId, selectedVersion.versionId);
      await refreshVersions(restored.versionId);
      setRestoreConfirmation('');
      setReadableStatus('Restored version');
    } catch (error) {
      console.error('Unable to restore this version.', error);
      setReadableStatus(readableVersionError('restore'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  const selectedVersionIsCurrentBranch = !selectedVersion || selectedVersion.branchId === branchId;

  return (
    <DocumentDrawer
      id="versions-drawer"
      title="Versions"
      open={open}
      onClose={onClose}
      className="versions-drawer"
      testId="versions-drawer"
    >
      <section className="document-drawer-section versions-drawer-current" aria-label="Current branch">
        <div className="document-drawer-section-heading">
          <span>Current</span>
        </div>
        {canSwitchBranches ? (
          <label className="versions-drawer-branch-control">
            <span>Branch</span>
            <select
              value={branchId}
              disabled={busyAction === 'load-branches' || branches.length === 0}
              onChange={(event) => handleBranchChange(event.currentTarget.value)}
              aria-label="Branch"
            >
              {branches.some((branch) => branch.branchId === branchId) ? null : <option value={branchId}>{branchId}</option>}
              {branches.map((branch) => (
                <option key={branch.branchId} value={branch.branchId} disabled={branch.isArchived}>
                  {branchLabel(branch)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="versions-drawer-branch-label">{currentBranchLabel ?? branchId}</p>
        )}
        <div className="document-drawer-action-row">
          <button type="button" onClick={() => void handleManualSave()} disabled={busyAction !== null}>
            {busyAction === 'manual-save' ? 'Saving' : 'Save version'}
          </button>
          <button type="button" onClick={() => void handleExportMarkdown()} disabled={busyAction !== null}>
            {busyAction === 'export' ? 'Exporting' : 'Export .md'}
          </button>
        </div>
      </section>

      <section className="document-drawer-section" aria-label="Branch versions">
        <div className="document-drawer-section-heading">
          <span>History</span>
          <span>{isLoadingVersions ? 'Loading' : `${versions.length}`}</span>
        </div>
        <div className="versions-drawer-list">
          {versions.map((version) => (
            <button
              key={version.versionId}
              type="button"
              className={version.versionId === selectedVersionId ? 'versions-drawer-row versions-drawer-row-active' : 'versions-drawer-row'}
              data-testid={`version-row-${version.versionNumber}`}
              onClick={() => setSelectedVersionId(version.versionId)}
            >
              <span className="versions-drawer-row-main">
                <strong>v{version.versionNumber}</strong>
                <span>{operationLabel(version.operation)}</span>
              </span>
              <span className="versions-drawer-row-meta">
                <time dateTime={version.createdAt}>{formatCreatedAt(version.createdAt)}</time>
                <code>{shortHash(version.hash)}</code>
              </span>
            </button>
          ))}
          {!isLoadingVersions && versions.length === 0 ? <p className="versions-drawer-empty">No versions on this branch.</p> : null}
        </div>
      </section>

      <section className="document-drawer-section" aria-label="Version preview">
        <div className="document-drawer-section-heading">
          <span>{selectedVersion ? `v${selectedVersion.versionNumber} preview` : 'Preview'}</span>
          <span>{isLoadingDetail ? 'Loading' : selectedVersion ? operationLabel(selectedVersion.operation) : 'No version'}</span>
        </div>
        <pre className="versions-drawer-preview" data-testid="version-preview">
          {selectedVersion?.markdown ?? ''}
        </pre>
      </section>

      {canBranchFromVersion || canRestoreVersion ? (
        <section className="document-drawer-section versions-drawer-advanced" aria-label="Advanced version actions">
          <div className="document-drawer-section-heading">
            <span>Advanced</span>
          </div>
          {canBranchFromVersion ? (
            <form className="versions-drawer-form" onSubmit={handleBranchFromVersion}>
              <label htmlFor="versions-drawer-new-branch-name">New branch name</label>
              <div className="document-drawer-action-row">
                <input
                  id="versions-drawer-new-branch-name"
                  type="text"
                  value={newBranchName}
                  onChange={(event) => setNewBranchName(event.currentTarget.value)}
                  disabled={!selectedVersion || busyAction !== null}
                  autoComplete="off"
                />
                <button type="submit" disabled={!selectedVersion || busyAction !== null}>
                  {busyAction === 'branch' ? 'Branching' : 'Branch from this version'}
                </button>
              </div>
            </form>
          ) : null}
          {canRestoreVersion ? (
            <form className="versions-drawer-form" onSubmit={handleRestoreVersion}>
              <label htmlFor="versions-drawer-restore-confirmation">Type RESTORE to confirm</label>
              <div className="document-drawer-action-row">
                <input
                  id="versions-drawer-restore-confirmation"
                  type="text"
                  value={restoreConfirmation}
                  onChange={(event) => setRestoreConfirmation(event.currentTarget.value)}
                  disabled={!selectedVersion || !selectedVersionIsCurrentBranch || busyAction !== null}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  disabled={
                    !selectedVersion ||
                    !selectedVersionIsCurrentBranch ||
                    restoreConfirmation !== 'RESTORE' ||
                    busyAction !== null
                  }
                >
                  {busyAction === 'restore' ? 'Restoring' : 'Restore this version'}
                </button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      <div className="document-drawer-status" role={statusKind}>
        {status}
      </div>
      <button type="button" className="document-drawer-link-button" onClick={onBackToDocuments ?? (() => window.location.assign('/'))}>
        Back to documents
      </button>
    </DocumentDrawer>
  );
}

export type { VersionsDrawerProps, SaveStatusKind };
