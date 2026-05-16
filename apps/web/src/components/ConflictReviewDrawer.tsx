import { useEffect, useState } from 'react';
import { DocumentDrawer } from './DocumentDrawer';
import {
  MarklabWebApi,
  type ConflictResolutionResponse,
  type ReconnectConflict,
} from '../lib/api-client';

interface ConflictReviewDrawerProps {
  api: MarklabWebApi;
  conflict: ReconnectConflict | null;
  open: boolean;
  onClose: () => void;
  onResolved: (response: ConflictResolutionResponse) => void | Promise<void>;
  onStatusChange: (status: string, kind: 'status' | 'alert') => void;
}

type BusyAction = 'use-shared' | 'use-local' | 'resolve';
type StatusKind = 'status' | 'alert';

const useSharedConfirmation = 'USE SHARED';
const useLocalConfirmation = 'USE LOCAL';
const applyResolvedConfirmation = 'APPLY RESOLVED';

function conflictErrorMessage(error: unknown, fallback: string): string {
  console.error(fallback, error);
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('stale_conflict_shared_state')) {
    return 'The shared session changed again. Reload the conflict and review the latest shared version before resolving.';
  }
  if (message.includes('conflict_already_resolved')) {
    return 'This conflict was already resolved. Reload the local document to continue.';
  }
  if (message.includes('forbidden')) {
    return 'You do not have permission to publish this resolution.';
  }
  if (message.includes('markdown_too_large')) {
    return 'The resolved Markdown is too large to apply.';
  }
  return fallback;
}

function formatConflictTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function conflictDiffPreview(localMarkdown: string, sharedMarkdown: string): string {
  const localLines = localMarkdown.replace(/\n$/u, '').split('\n');
  const sharedLines = sharedMarkdown.replace(/\n$/u, '').split('\n');
  const lineCount = Math.max(localLines.length, sharedLines.length);
  const preview: string[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    const localLine = localLines[index];
    const sharedLine = sharedLines[index];
    if (localLine === sharedLine) {
      if (localLine !== undefined) preview.push(`  ${localLine}`);
      continue;
    }
    if (localLine !== undefined) preview.push(`- ${localLine}`);
    if (sharedLine !== undefined) preview.push(`+ ${sharedLine}`);
  }
  return preview.join('\n');
}

export function ConflictReviewDrawer({
  api,
  conflict,
  open,
  onClose,
  onResolved,
  onStatusChange,
}: ConflictReviewDrawerProps) {
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [status, setStatus] = useState<string>('Both original versions were snapshotted and remain recoverable.');
  const [statusKind, setStatusKind] = useState<StatusKind>('status');
  const [sharedConfirmation, setSharedConfirmation] = useState('');
  const [localConfirmation, setLocalConfirmation] = useState('');
  const [resolvedConfirmation, setResolvedConfirmation] = useState('');
  const [resolvedMarkdown, setResolvedMarkdown] = useState('');

  const conflictId = conflict?.conflictId ?? null;
  const conflictResetKey = conflict
    ? [
        conflict.conflictId,
        conflict.localHash,
        conflict.sharedHash,
        conflict.baseHash ?? '',
        conflict.sharedRevision,
        conflict.updatedAt,
      ].join(':')
    : null;
  useEffect(() => {
    if (!open) return;
    setBusyAction(null);
    setStatus('Both original versions were snapshotted and remain recoverable.');
    setStatusKind('status');
    setSharedConfirmation('');
    setLocalConfirmation('');
    setResolvedConfirmation('');
    setResolvedMarkdown('');
  }, [conflictId, conflictResetKey, open]);

  if (!open || !conflict) return null;
  const activeConflict = conflict;

  function setDrawerStatus(nextStatus: string, nextKind: StatusKind = 'status') {
    setStatus(nextStatus);
    setStatusKind(nextKind);
    onStatusChange(nextStatus, nextKind);
  }

  async function runResolution(action: BusyAction, operation: () => Promise<ConflictResolutionResponse>) {
    setBusyAction(action);
    try {
      const response = await operation();
      setDrawerStatus('Conflict resolved. Sync resumed.');
      await onResolved(response);
    } catch (error) {
      setDrawerStatus(conflictErrorMessage(error, 'Unable to resolve this conflict.'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  function handleUseShared() {
    void runResolution('use-shared', () => api.useSharedLocalConflict(activeConflict.conflictId, {
      expectedSharedRevision: activeConflict.expectedSharedRevision ?? activeConflict.sharedRevision,
      expectedSharedHash: activeConflict.expectedSharedHash ?? activeConflict.sharedHash,
    }));
  }

  function handleUseLocal() {
    void runResolution('use-local', () =>
      api.useLocalLocalConflict(activeConflict.conflictId, {
        expectedSharedRevision: activeConflict.expectedSharedRevision ?? activeConflict.sharedRevision,
        expectedSharedHash: activeConflict.expectedSharedHash ?? activeConflict.sharedHash,
      }),
    );
  }

  function handleResolve() {
    if (resolvedMarkdown.trim().length === 0 || resolvedConfirmation !== applyResolvedConfirmation) {
      setDrawerStatus('Paste resolved Markdown and type APPLY RESOLVED before applying it.', 'alert');
      return;
    }
    void runResolution('resolve', () =>
      api.resolveLocalConflict(activeConflict.conflictId, {
        markdown: resolvedMarkdown,
        expectedSharedRevision: activeConflict.expectedSharedRevision ?? activeConflict.sharedRevision,
        expectedSharedHash: activeConflict.expectedSharedHash ?? activeConflict.sharedHash,
      }),
    );
  }

  const isBusy = busyAction !== null;
  const canUseShared = sharedConfirmation === useSharedConfirmation && !isBusy;
  const canUseLocal = localConfirmation === useLocalConfirmation && !isBusy;
  const canResolve = resolvedMarkdown.trim().length > 0 && resolvedConfirmation === applyResolvedConfirmation && !isBusy;
  const diffPreview = conflictDiffPreview(activeConflict.localMarkdown, activeConflict.sharedMarkdown);

  return (
    <DocumentDrawer
      id="conflict-review-drawer"
      title="Sync paused"
      open={open}
      onClose={onClose}
      closeLabel="Close conflict review"
      className="conflict-review-drawer"
      bodyClassName="conflict-review-body"
      testId="conflict-review-drawer"
      footer={
        <div className="conflict-review-footer">
          <button type="button" onClick={onClose} disabled={isBusy}>
            Keep paused
          </button>
        </div>
      }
    >
      <section className="document-drawer-section conflict-review-summary" aria-label="Conflict summary">
        <p className="conflict-review-lede">This file changed locally while the shared session also changed.</p>
        <p>
          Both original versions were snapshotted and remain recoverable. Compare the captured versions first, then choose
          one resolution.
        </p>
        <dl className="conflict-review-meta">
          <div>
            <dt>Local file</dt>
            <dd>{activeConflict.localPath}</dd>
          </div>
          <div>
            <dt>Shared revision</dt>
            <dd>{activeConflict.sharedRevision}</dd>
          </div>
          <div>
            <dt>Paused</dt>
            <dd>
              <time dateTime={activeConflict.createdAt}>{formatConflictTime(activeConflict.createdAt)}</time>
            </dd>
          </div>
        </dl>
      </section>

      <section className="document-drawer-section conflict-preview-section" aria-label="My local version">
        <div className="document-drawer-section-heading">
          <span>My local version</span>
          <code>{activeConflict.localHash.slice(0, 8)}</code>
        </div>
        <pre>{activeConflict.localMarkdown}</pre>
      </section>

      <section className="document-drawer-section conflict-preview-section" aria-label="Shared version">
        <div className="document-drawer-section-heading">
          <span>Shared version</span>
          <code>{activeConflict.sharedHash.slice(0, 8)}</code>
        </div>
        <pre>{activeConflict.sharedMarkdown}</pre>
      </section>

      {activeConflict.baseMarkdown !== null ? (
        <section className="document-drawer-section conflict-preview-section" aria-label="Base version">
          <div className="document-drawer-section-heading">
            <span>Base version</span>
            {activeConflict.baseHash ? <code>{activeConflict.baseHash.slice(0, 8)}</code> : null}
          </div>
          <pre>{activeConflict.baseMarkdown}</pre>
        </section>
      ) : null}

      <section className="document-drawer-section conflict-preview-section conflict-diff-section" aria-label="Conflict diff">
        <div className="document-drawer-section-heading">
          <span>Conflict diff</span>
          <code>{activeConflict.lastProjectedHash.slice(0, 8)}</code>
        </div>
        <pre>{diffPreview}</pre>
      </section>

      <section className="document-drawer-section conflict-resolution-intro" aria-label="Resolution choices">
        <div className="document-drawer-section-heading">
          <span>Choose a resolution</span>
        </div>
        <p>Pick exactly one path: keep your local version, take the shared version, or paste resolved Markdown.</p>
      </section>

      <section className="document-drawer-section conflict-action-card" aria-label="Use my local version confirmation">
        <div>
          <h3>Use my local version</h3>
          <p>Publishes your local version to everyone in the shared session.</p>
        </div>
        <label htmlFor="conflict-use-local-confirmation">Type USE LOCAL to confirm</label>
        <input
          id="conflict-use-local-confirmation"
          value={localConfirmation}
          onChange={(event) => setLocalConfirmation(event.currentTarget.value)}
          disabled={isBusy}
          spellCheck={false}
        />
        <button type="button" onClick={handleUseLocal} disabled={!canUseLocal}>
          Use my local version
        </button>
      </section>

      <section className="document-drawer-section conflict-action-card" aria-label="Use shared version confirmation">
        <div>
          <h3>Use shared version</h3>
          <p>Replaces your local file with the shared version captured when sync paused.</p>
        </div>
        <label htmlFor="conflict-use-shared-confirmation">Type USE SHARED to confirm</label>
        <input
          id="conflict-use-shared-confirmation"
          value={sharedConfirmation}
          onChange={(event) => setSharedConfirmation(event.currentTarget.value)}
          disabled={isBusy}
          spellCheck={false}
        />
        <button type="button" onClick={handleUseShared} disabled={!canUseShared}>
          Use shared version
        </button>
      </section>

      <section className="document-drawer-section conflict-action-card conflict-resolved-card" aria-label="Resolved Markdown">
        <div>
          <h3>Paste resolved Markdown</h3>
          <p>Paste the final Markdown you want MarkLab to apply to the local file and shared session.</p>
        </div>
        <label htmlFor="conflict-resolved-markdown">Resolved Markdown</label>
        <textarea
          id="conflict-resolved-markdown"
          className="conflict-resolved-markdown"
          value={resolvedMarkdown}
          onChange={(event) => setResolvedMarkdown(event.currentTarget.value)}
          disabled={isBusy}
          spellCheck={false}
        />
        {resolvedMarkdown.trim().length > 0 ? (
          <div className="conflict-resolved-preview" aria-label="Resolved Markdown preview">
            <div className="document-drawer-section-heading">
              <span>Review resolved Markdown</span>
            </div>
            <pre>{resolvedMarkdown}</pre>
          </div>
        ) : null}
        <label htmlFor="conflict-resolved-confirmation">Type APPLY RESOLVED to confirm</label>
        <input
          id="conflict-resolved-confirmation"
          value={resolvedConfirmation}
          onChange={(event) => setResolvedConfirmation(event.currentTarget.value)}
          disabled={isBusy}
          spellCheck={false}
        />
        <button type="button" onClick={handleResolve} disabled={!canResolve}>
          Apply resolved Markdown
        </button>
      </section>

      <div className="document-drawer-status" role={statusKind}>
        {status}
      </div>
    </DocumentDrawer>
  );
}

export type { ConflictReviewDrawerProps };
