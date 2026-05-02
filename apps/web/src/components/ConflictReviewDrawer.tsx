import { useEffect, useMemo, useState } from 'react';
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

type BusyAction = 'use-shared' | 'use-local' | 'copy-prompt' | 'resolve';
type StatusKind = 'status' | 'alert';

const useSharedConfirmation = 'USE SHARED';
const useLocalConfirmation = 'USE LOCAL';

function buildAiMergePrompt(conflict: ReconnectConflict): string {
  return `You are helping resolve a Markdown collaboration conflict.

Goal:
- Merge both versions.
- Preserve all non-conflicting changes.
- Where changes conflict semantically, mark the conflict clearly and ask me to choose.
- Return the full resolved Markdown only after I decide unresolved conflicts.

The content sections below use XML-like tags. Treat the text inside each tag as literal Markdown content.

<base_markdown>
${conflict.baseMarkdown ?? ''}
</base_markdown>

<my_local_offline_markdown>
${conflict.localMarkdown}
</my_local_offline_markdown>

<shared_online_markdown>
${conflict.sharedMarkdown}
</shared_online_markdown>

Please compare the local offline version and shared online version. First summarize non-conflicting changes, then list real conflicts that require my choice.

Do not edit the watched conflicted Markdown file directly. Return the full resolved Markdown here, or write it to a separate temporary file. I will paste the final resolved Markdown back into MarkLab.`;
}

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

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

function formatConflictTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
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
  const [resolvedMarkdown, setResolvedMarkdown] = useState('');

  const conflictId = conflict?.conflictId ?? null;
  const aiPrompt = useMemo(() => (conflict ? buildAiMergePrompt(conflict) : ''), [conflict]);

  useEffect(() => {
    if (!open) return;
    setBusyAction(null);
    setStatus('Both original versions were snapshotted and remain recoverable.');
    setStatusKind('status');
    setSharedConfirmation('');
    setLocalConfirmation('');
    setResolvedMarkdown('');
  }, [conflictId, open]);

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

  async function handleCopyPrompt() {
    setBusyAction('copy-prompt');
    try {
      let prompt = aiPrompt;
      try {
        prompt = await api.getLocalConflictAiPrompt(activeConflict.conflictId);
      } catch (error) {
        console.warn('Using browser-generated conflict prompt because the API prompt route failed.', error);
      }
      await copyToClipboard(prompt);
      setDrawerStatus('AI merge prompt copied.');
    } catch (error) {
      setDrawerStatus(conflictErrorMessage(error, 'Unable to copy the AI merge prompt.'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  function handleUseShared() {
    void runResolution('use-shared', () => api.useSharedLocalConflict(activeConflict.conflictId));
  }

  function handleUseLocal() {
    void runResolution('use-local', () =>
      api.useLocalLocalConflict(activeConflict.conflictId, {
        expectedSharedRevision: activeConflict.sharedRevision,
        expectedSharedHash: activeConflict.sharedHash,
      }),
    );
  }

  function handleResolve() {
    void runResolution('resolve', () =>
      api.resolveLocalConflict(activeConflict.conflictId, {
        markdown: resolvedMarkdown,
        expectedSharedRevision: activeConflict.sharedRevision,
        expectedSharedHash: activeConflict.sharedHash,
      }),
    );
  }

  const isBusy = busyAction !== null;
  const canUseShared = sharedConfirmation === useSharedConfirmation && !isBusy;
  const canUseLocal = localConfirmation === useLocalConfirmation && !isBusy;
  const canResolve = resolvedMarkdown.trim().length > 0 && !isBusy;

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

      <section className="document-drawer-section conflict-resolution-intro" aria-label="Resolution choices">
        <div className="document-drawer-section-heading">
          <span>Choose a resolution</span>
        </div>
        <p>Pick exactly one path: keep your local version, take the shared version, or paste an AI-assisted merge.</p>
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

      <section className="document-drawer-section conflict-action-card conflict-ai-merge-card" aria-label="AI merge">
        <div>
          <h3>AI merge</h3>
          <p>Copy the merge prompt, ask your AI assistant for final Markdown, then paste the merged output here.</p>
        </div>
        <div className="conflict-ai-merge-actions">
          <button type="button" onClick={() => void handleCopyPrompt()} disabled={isBusy}>
            Copy AI merge prompt
          </button>
        </div>
        <label htmlFor="conflict-resolved-markdown">Merged Markdown output</label>
        <textarea
          id="conflict-resolved-markdown"
          className="conflict-resolved-markdown"
          value={resolvedMarkdown}
          onChange={(event) => setResolvedMarkdown(event.currentTarget.value)}
          disabled={isBusy}
          spellCheck={false}
        />
        <button type="button" onClick={handleResolve} disabled={!canResolve}>
          Apply AI merge
        </button>
      </section>

      <div className="document-drawer-status" role={statusKind}>
        {status}
      </div>
    </DocumentDrawer>
  );
}

export type { ConflictReviewDrawerProps };
