import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { MarklabWebApi } from '../lib/api-client';
import { buildDocumentPath } from '../routes';
import { DocumentDrawer } from './DocumentDrawer';

type AccessGrantRole = 'view' | 'edit';
type AccessClientKind = 'browser' | 'agent' | 'api';
type ShareStatusKind = 'status' | 'alert';

interface AccessSessionSummary {
  sessionId: string;
  clientKind: AccessClientKind;
  displayName: string;
  color: string;
  lastBranchId: string | null;
  lastSeenAt: string | null;
}

interface AccessGrantSummary {
  grantId: string;
  role: AccessGrantRole;
  branchId: string;
  branchName: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  sessions: AccessSessionSummary[];
}

interface CreatedAccessGrant {
  grantId: string;
  branchId: string;
  token: string;
  role: AccessGrantRole;
  expiresAt: string | null;
  createdAt: string;
}

interface AccessGrantsResponse {
  grants: AccessGrantSummary[];
}

interface AccessGrantApi {
  createAccessGrant(docId: string, branchId: string, input: { role: AccessGrantRole }): Promise<CreatedAccessGrant>;
  listAccessGrants(docId: string, branchId: string): Promise<AccessGrantsResponse>;
  revokeAccessGrant(grantId: string): Promise<void>;
}

interface ShareDrawerProps {
  docId: string;
  branchId: string;
  open: boolean;
  onClose: () => void;
  canManageAccess?: boolean;
  collaboratorName?: string;
  showCollaboratorName?: boolean;
  onCollaboratorNameChange?: (name: string) => void | Promise<void>;
  onStatusChange?: (status: string, kind: ShareStatusKind) => void;
  accessApi?: AccessGrantApi;
}

interface CreatedAccessLink {
  grantId: string;
  role: AccessGrantRole;
  url: string;
}

type BusyAction = 'create' | 'load' | 'name' | 'revoke';

function hasAccessGrantApi(value: Partial<AccessGrantApi>): value is AccessGrantApi {
  return (
    typeof value.createAccessGrant === 'function' &&
    typeof value.listAccessGrants === 'function' &&
    typeof value.revokeAccessGrant === 'function'
  );
}

function formatCreatedAt(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function buildAccessUrl(docId: string, branchId: string, token: string, role: AccessGrantRole): string {
  const url = new URL(buildDocumentPath(docId, branchId), window.location.origin);
  url.searchParams.set('token', token);
  url.searchParams.set('mode', role);
  return url.toString();
}

function aiPromptForLink(role: AccessGrantRole, accessUrl: string): string {
  if (role === 'view') {
    return [
      'You have view-only access to the shared branch of this MarkLab document.',
      '',
      'Open this access link:',
      accessUrl,
      '',
      'You may read, quote, summarize, and explain the shared branch. Do not attempt to edit it or switch branches.',
    ].join('\n');
  }

  return [
    'You have edit access to the shared branch of this MarkLab document.',
    '',
    'Open this access link:',
    accessUrl,
    '',
    'When MarkLab asks for your collaborator name, identify yourself clearly. You may read and edit the shared branch through MarkLab. Preserve document structure and avoid unrelated changes.',
  ].join('\n');
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function readableAccessError(action: string): string {
  if (action === 'create') return 'Unable to create access link.';
  if (action === 'revoke') return 'Unable to revoke access link.';
  if (action === 'name') return 'Unable to update collaboration name.';
  return 'Unable to load share settings.';
}

function recentSessionsFromGrants(grants: AccessGrantSummary[]): AccessSessionSummary[] {
  return grants
    .flatMap((grant) => grant.sessions)
    .sort((left, right) => {
      const leftTime = left.lastSeenAt ? new Date(left.lastSeenAt).getTime() : 0;
      const rightTime = right.lastSeenAt ? new Date(right.lastSeenAt).getTime() : 0;
      return rightTime - leftTime;
    });
}

export function ShareDrawer({
  docId,
  branchId,
  open,
  onClose,
  canManageAccess = true,
  collaboratorName = '',
  showCollaboratorName = false,
  onCollaboratorNameChange,
  onStatusChange,
  accessApi,
}: ShareDrawerProps) {
  const maybeAccessApi = useMemo<Partial<AccessGrantApi>>(
    () => accessApi ?? (new MarklabWebApi() as unknown as Partial<AccessGrantApi>),
    [accessApi],
  );
  const [grants, setGrants] = useState<AccessGrantSummary[]>([]);
  const [role, setRole] = useState<AccessGrantRole>('view');
  const [createdLink, setCreatedLink] = useState<CreatedAccessLink | null>(null);
  const [nameDraft, setNameDraft] = useState(collaboratorName);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<ShareStatusKind>('status');
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);

  const setReadableStatus = useCallback(
    (nextStatus: string, kind: ShareStatusKind = 'status') => {
      setStatusKind(kind);
      setStatus(nextStatus);
      onStatusChange?.(nextStatus, kind);
    },
    [onStatusChange],
  );

  const refreshGrants = useCallback(async () => {
    if (!canManageAccess) return;
    if (!hasAccessGrantApi(maybeAccessApi)) {
      setReadableStatus('Access grants API is not wired in the web client yet.', 'alert');
      return;
    }

    setBusyAction('load');
    try {
      const response = await maybeAccessApi.listAccessGrants(docId, branchId);
      setGrants(response.grants);
    } catch (error) {
      console.error('Unable to load share settings.', error);
      setReadableStatus(readableAccessError('load'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }, [branchId, canManageAccess, docId, maybeAccessApi, setReadableStatus]);

  useEffect(() => {
    setNameDraft(collaboratorName);
  }, [collaboratorName]);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setCreatedLink(null);
    void refreshGrants();
  }, [open, refreshGrants]);

  async function handleCreateAccessLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageAccess) return;
    if (!hasAccessGrantApi(maybeAccessApi)) {
      setReadableStatus('Access grants API is not wired in the web client yet.', 'alert');
      return;
    }

    setBusyAction('create');
    setStatus(null);
    try {
      const created = await maybeAccessApi.createAccessGrant(docId, branchId, { role });
      const url = buildAccessUrl(docId, branchId, created.token, created.role);
      setCreatedLink({ grantId: created.grantId, role: created.role, url });
      setReadableStatus('Access link created. Copy it now; it will not be shown again.');
      await refreshGrants();
    } catch (error) {
      console.error('Unable to create access link.', error);
      setReadableStatus(readableAccessError('create'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRevokeAccessLink(grant: AccessGrantSummary) {
    if (!hasAccessGrantApi(maybeAccessApi)) {
      setReadableStatus('Access grants API is not wired in the web client yet.', 'alert');
      return;
    }
    if (!window.confirm('Revoke this link for everyone using it?')) return;

    setBusyAction('revoke');
    setStatus(null);
    try {
      await maybeAccessApi.revokeAccessGrant(grant.grantId);
      setGrants((current) => current.filter((candidate) => candidate.grantId !== grant.grantId));
      setReadableStatus('Access link revoked.');
    } catch (error) {
      console.error('Unable to revoke access link.', error);
      setReadableStatus(readableAccessError('revoke'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCollaboratorNameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onCollaboratorNameChange) return;

    const normalizedName = nameDraft.trim();
    setBusyAction('name');
    try {
      await onCollaboratorNameChange(normalizedName);
      setReadableStatus('Collaboration name updated.');
    } catch (error) {
      console.error('Unable to update collaboration name.', error);
      setReadableStatus(readableAccessError('name'), 'alert');
    } finally {
      setBusyAction(null);
    }
  }

  const recentSessions = recentSessionsFromGrants(grants);

  return (
    <DocumentDrawer id="share-drawer" title="Share" open={open} onClose={onClose} className="share-drawer" testId="share-drawer">
      {canManageAccess ? (
        <>
          <section className="document-drawer-section share-drawer-access-link" aria-label="Access link">
            <div className="document-drawer-section-heading">
              <span>Access link</span>
            </div>
            <form className="share-drawer-form" onSubmit={handleCreateAccessLink}>
              <div className="share-drawer-role-segments" role="group" aria-label="Access link role">
                <button
                  type="button"
                  className={role === 'view' ? 'share-drawer-role share-drawer-role-active' : 'share-drawer-role'}
                  aria-pressed={role === 'view'}
                  onClick={() => setRole('view')}
                >
                  View
                </button>
                <button
                  type="button"
                  className={role === 'edit' ? 'share-drawer-role share-drawer-role-active' : 'share-drawer-role'}
                  aria-pressed={role === 'edit'}
                  onClick={() => setRole('edit')}
                >
                  Edit
                </button>
              </div>
              <button type="submit" disabled={busyAction !== null}>
                {busyAction === 'create' ? 'Creating' : 'Create link'}
              </button>
            </form>
          </section>

          {createdLink ? (
            <section className="document-drawer-section share-drawer-created-link" data-testid="created-access-link">
              <div className="document-drawer-section-heading">
                <span>Created link</span>
              </div>
              <code data-testid="created-access-url">{createdLink.url}</code>
              <div className="document-drawer-action-row">
                <button type="button" onClick={() => void copyText(createdLink.url)}>
                  Copy
                </button>
                <button type="button" onClick={() => void copyText(aiPromptForLink(createdLink.role, createdLink.url))}>
                  Copy AI prompt
                </button>
              </div>
            </section>
          ) : null}

          <section className="document-drawer-section" aria-label="Active links">
            <div className="document-drawer-section-heading">
              <span>Active links</span>
              <button type="button" onClick={() => void refreshGrants()} disabled={busyAction !== null}>
                Refresh
              </button>
            </div>
            <div className="share-drawer-list">
              {grants.length > 0 ? (
                grants.map((grant) => (
                  <div className="share-drawer-row" key={grant.grantId}>
                    <span>
                      <strong>{grant.role === 'edit' ? 'Edit link' : 'View link'}</strong>
                      <small>
                        {grant.branchName || grant.branchId} · {formatCreatedAt(grant.createdAt)}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="share-drawer-revoke"
                      onClick={() => void handleRevokeAccessLink(grant)}
                      disabled={busyAction !== null}
                    >
                      Revoke
                    </button>
                  </div>
                ))
              ) : (
                <p>No active access links.</p>
              )}
            </div>
          </section>

          <section className="document-drawer-section" aria-label="Recent sessions">
            <div className="document-drawer-section-heading">
              <span>Recent sessions</span>
            </div>
            <div className="share-drawer-list">
              {recentSessions.length > 0 ? (
                recentSessions.map((session) => (
                  <div className="share-drawer-row" key={session.sessionId}>
                    <span>
                      <strong>{session.displayName || 'Guest'}</strong>
                      <small>
                        {session.clientKind} · {formatCreatedAt(session.lastSeenAt)}
                      </small>
                    </span>
                  </div>
                ))
              ) : (
                <p>No recent sessions.</p>
              )}
            </div>
          </section>
        </>
      ) : (
        <p className="share-drawer-read-only">Share controls are not available for view-only access.</p>
      )}

      {showCollaboratorName ? (
        <section className="document-drawer-section" aria-label="My collaboration name">
          <div className="document-drawer-section-heading">
            <span>My collaboration name</span>
          </div>
          <form className="share-drawer-form" onSubmit={handleCollaboratorNameSubmit}>
            <input
              type="text"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              disabled={!onCollaboratorNameChange || busyAction !== null}
              autoComplete="name"
              aria-label="My collaboration name"
            />
            <button type="submit" disabled={!onCollaboratorNameChange || busyAction !== null}>
              {busyAction === 'name' ? 'Changing' : 'Change'}
            </button>
          </form>
        </section>
      ) : null}

      <div className="document-drawer-status" role={statusKind}>
        {status ?? (busyAction === 'load' ? 'Loading share settings' : '')}
      </div>
    </DocumentDrawer>
  );
}

export type {
  AccessClientKind,
  AccessGrantApi,
  AccessGrantRole,
  AccessGrantSummary,
  AccessGrantsResponse,
  AccessSessionSummary,
  CreatedAccessGrant,
  ShareDrawerProps,
  ShareStatusKind,
};
