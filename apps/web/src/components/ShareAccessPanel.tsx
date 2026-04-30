import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  MarklabWebApi,
  type AgentTokenSummary,
  type ShareLinkRole,
  type ShareLinkSummary,
} from '../lib/api-client';
import { buildDocumentPath } from '../routes';

interface ShareAccessPanelProps {
  docId: string;
  branchId: string;
}

type BusyAction = 'agent' | 'share' | 'load' | 'revoke-agent' | 'revoke-share';

interface CreatedSecret {
  kind: 'agent' | 'share';
  label: string;
  token: string;
  url?: string;
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

function buildShareUrl(docId: string, branchId: string, token: string, role: ShareLinkRole): string {
  const url = new URL(buildDocumentPath(docId, branchId), window.location.origin);
  url.searchParams.set('token', token);
  url.searchParams.set('mode', role);
  return url.toString();
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export function ShareAccessPanel({ docId, branchId }: ShareAccessPanelProps) {
  const api = useMemo(() => new MarklabWebApi(), []);
  const [agentTokens, setAgentTokens] = useState<AgentTokenSummary[]>([]);
  const [shareLinks, setShareLinks] = useState<ShareLinkSummary[]>([]);
  const [agentName, setAgentName] = useState('Agent');
  const [agentCanWrite, setAgentCanWrite] = useState(false);
  const [shareRole, setShareRole] = useState<ShareLinkRole>('view');
  const [createdSecret, setCreatedSecret] = useState<CreatedSecret | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>('load');
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'status' | 'alert'>('status');

  async function refreshAccess() {
    setBusyAction('load');
    setStatus(null);
    try {
      const [tokensResponse, linksResponse] = await Promise.all([
        api.listAgentTokens(docId, branchId),
        api.listShareLinks(docId, branchId),
      ]);
      setAgentTokens(tokensResponse.tokens);
      setShareLinks(linksResponse.links);
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? error.message : 'Unable to load access settings.');
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    void refreshAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, docId]);

  async function handleCreateAgentToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = agentName.trim();
    if (!normalizedName) {
      setStatusKind('alert');
      setStatus('Agent token name is required.');
      return;
    }

    setBusyAction('agent');
    setStatus(null);
    try {
      const created = await api.createAgentToken(docId, branchId, {
        name: normalizedName,
        canWrite: agentCanWrite,
      });
      setCreatedSecret({
        kind: 'agent',
        label: created.name,
        token: created.token,
      });
      setAgentTokens((current) => [
        { ...created, createdAt: new Date().toISOString() },
        ...current.filter((token) => token.tokenId !== created.tokenId),
      ]);
      setStatusKind('status');
      setStatus('Agent token created. Copy it now; it will not be shown again.');
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? error.message : 'Unable to create agent token.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreateShareLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction('share');
    setStatus(null);
    try {
      const created = await api.createShareLink(docId, branchId, { role: shareRole });
      const url = buildShareUrl(docId, branchId, created.token, created.role);
      setCreatedSecret({
        kind: 'share',
        label: `${created.role} link`,
        token: created.token,
        url,
      });
      setShareLinks((current) => [
        { ...created, createdAt: new Date().toISOString() },
        ...current.filter((link) => link.linkId !== created.linkId),
      ]);
      setStatusKind('status');
      setStatus('Share link created. Copy it now; the token will not be shown again.');
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? error.message : 'Unable to create share link.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRevokeAgentToken(token: AgentTokenSummary) {
    setBusyAction('revoke-agent');
    setStatus(null);
    try {
      await api.revokeAgentToken(token.tokenId);
      setAgentTokens((current) => current.filter((candidate) => candidate.tokenId !== token.tokenId));
      setStatusKind('status');
      setStatus(`Revoked agent token ${token.name}.`);
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? error.message : 'Unable to revoke agent token.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRevokeShareLink(link: ShareLinkSummary) {
    setBusyAction('revoke-share');
    setStatus(null);
    try {
      await api.revokeShareLink(link.linkId);
      setShareLinks((current) => current.filter((candidate) => candidate.linkId !== link.linkId));
      setStatusKind('status');
      setStatus(`Revoked ${link.role} share link.`);
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? error.message : 'Unable to revoke share link.');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className="share-access-panel" data-testid="share-access-panel" aria-label="Share access">
      <div className="version-panel-heading">
        <div>
          <p className="workspace-kicker">Access</p>
          <h2>Share</h2>
        </div>
        <button type="button" onClick={() => void refreshAccess()} disabled={busyAction !== null}>
          Refresh
        </button>
      </div>

      {createdSecret ? (
        <div className="created-secret" data-testid="created-secret">
          <div className="created-secret-heading">
            <strong>{createdSecret.label}</strong>
            <button type="button" onClick={() => void copyText(createdSecret.url ?? createdSecret.token)}>
              Copy
            </button>
          </div>
          <code data-testid={createdSecret.kind === 'share' ? 'created-share-token' : 'created-agent-token'}>
            {createdSecret.token}
          </code>
          {createdSecret.url ? <code data-testid="created-share-url">{createdSecret.url}</code> : null}
        </div>
      ) : null}

      <form className="share-access-form" onSubmit={handleCreateShareLink}>
        <label htmlFor="share-link-role">Share link role</label>
        <div className="share-access-row">
          <select
            id="share-link-role"
            value={shareRole}
            onChange={(event) => setShareRole(event.currentTarget.value as ShareLinkRole)}
            disabled={busyAction !== null}
          >
            <option value="view">View</option>
            <option value="edit">Edit</option>
          </select>
          <button type="submit" disabled={busyAction !== null}>
            {busyAction === 'share' ? 'Creating...' : 'Create share link'}
          </button>
        </div>
      </form>

      <form className="share-access-form" onSubmit={handleCreateAgentToken}>
        <label htmlFor="agent-token-name">Agent token name</label>
        <input
          id="agent-token-name"
          type="text"
          value={agentName}
          onChange={(event) => setAgentName(event.currentTarget.value)}
          disabled={busyAction !== null}
          autoComplete="off"
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={agentCanWrite}
            onChange={(event) => setAgentCanWrite(event.currentTarget.checked)}
            disabled={busyAction !== null}
          />
          <span>Allow writes</span>
        </label>
        <button type="submit" disabled={busyAction !== null}>
          {busyAction === 'agent' ? 'Creating...' : 'Create agent token'}
        </button>
      </form>

      <div className="access-list" aria-label="Share links">
        <h3>Links</h3>
        {shareLinks.length > 0 ? (
          shareLinks.map((link) => (
            <div className="access-row" key={link.linkId}>
              <span>
                <strong>{link.role}</strong>
                <small>{formatCreatedAt(link.createdAt)}</small>
              </span>
              <button
                type="button"
                onClick={() => void handleRevokeShareLink(link)}
                disabled={busyAction !== null}
                aria-label={`Revoke ${link.role} share link`}
              >
                Revoke
              </button>
            </div>
          ))
        ) : (
          <p>No active share links.</p>
        )}
      </div>

      <div className="access-list" aria-label="Agent tokens">
        <h3>Agent tokens</h3>
        {agentTokens.length > 0 ? (
          agentTokens.map((token) => (
            <div className="access-row" key={token.tokenId}>
              <span>
                <strong>{token.name}</strong>
                <small>{token.canWrite ? 'read/write' : 'read-only'} · {formatCreatedAt(token.createdAt)}</small>
              </span>
              <button
                type="button"
                onClick={() => void handleRevokeAgentToken(token)}
                disabled={busyAction !== null}
                aria-label={`Revoke agent token ${token.name}`}
              >
                Revoke
              </button>
            </div>
          ))
        ) : (
          <p>No active agent tokens.</p>
        )}
      </div>

      <span className="share-access-status" role={statusKind}>
        {status ?? (busyAction === 'load' ? 'Loading access settings...' : '')}
      </span>
    </section>
  );
}
