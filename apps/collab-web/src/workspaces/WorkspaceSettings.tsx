import { useEffect, useMemo, useState } from 'react';
import {
  createWorkspaceSettingsClient,
  type WorkspaceDocument,
  type WorkspaceInviteRole,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSettingsClient,
  type WorkspaceShareKey,
} from '../api/workspace-settings';

export interface WorkspaceSettingsProps {
  workspaceId: string;
  client?: WorkspaceSettingsClient | undefined;
}

type SettingsTab = 'members' | 'documents';

const memberRoles: WorkspaceRole[] = ['Owner', 'Member', 'Reader'];
const inviteRoles: WorkspaceInviteRole[] = ['Member', 'Reader'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'workspace_settings_unavailable';
}

export function WorkspaceSettings({ workspaceId, client: injectedClient }: WorkspaceSettingsProps) {
  const defaultClient = useMemo(() => createWorkspaceSettingsClient(), []);
  const client = injectedClient ?? defaultClient;
  const [activeTab, setActiveTab] = useState<SettingsTab>('members');
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, WorkspaceRole>>({});
  const [inviteRole, setInviteRole] = useState<WorkspaceInviteRole>('Member');
  const [createdKey, setCreatedKey] = useState<WorkspaceShareKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);

    void Promise.all([
      client.listMembers(workspaceId),
      client.listDocuments(workspaceId),
    ]).then(([nextMembers, nextDocuments]) => {
      if (disposed) return;
      setMembers(nextMembers);
      setDocuments(nextDocuments);
      setRoleDrafts({});
      setLoading(false);
    }).catch((loadError: unknown) => {
      if (disposed) return;
      setError(errorMessage(loadError));
      setLoading(false);
    });

    return () => {
      disposed = true;
    };
  }, [client, workspaceId]);

  const createInvite = async () => {
    setError(null);
    try {
      const key = await client.createShareKey(workspaceId, { role: inviteRole });
      setCreatedKey(key);
    } catch (inviteError) {
      setError(errorMessage(inviteError));
    }
  };

  const updateRole = async (member: WorkspaceMember) => {
    setError(null);
    const role = roleDrafts[member.userId] ?? member.role;
    try {
      const updated = await client.updateMemberRole(workspaceId, member.userId, role);
      setMembers((current) => current.map((candidate) => (candidate.userId === updated.userId ? updated : candidate)));
      setRoleDrafts((current) => {
        const { [member.userId]: _discarded, ...rest } = current;
        return rest;
      });
    } catch (updateError) {
      setError(errorMessage(updateError));
      setRoleDrafts((current) => {
        const { [member.userId]: _discarded, ...rest } = current;
        return rest;
      });
    }
  };

  const removeMember = async (member: WorkspaceMember) => {
    setError(null);
    try {
      await client.removeMember(workspaceId, member.userId);
      setMembers((current) => current.filter((candidate) => candidate.userId !== member.userId));
    } catch (removeError) {
      setError(errorMessage(removeError));
    }
  };

  const changeMemberRole = (userId: string, role: WorkspaceRole) => {
    setRoleDrafts((current) => ({ ...current, [userId]: role }));
  };

  return (
    <main className="settings-shell">
      <header className="collab-topbar">
        <div>
          <h1>Workspace Settings</h1>
          <p>{workspaceId}</p>
        </div>
      </header>
      <nav className="settings-tabs" aria-label="Workspace settings">
        <button
          type="button"
          className={activeTab === 'members' ? 'active' : undefined}
          onClick={() => setActiveTab('members')}
        >
          Members
        </button>
        <button
          type="button"
          className={activeTab === 'documents' ? 'active' : undefined}
          onClick={() => setActiveTab('documents')}
        >
          Documents
        </button>
        <button type="button" disabled>Plan & Billing</button>
      </nav>
      {error ? (
        <section className="unavailable-banner" role="status">{error}</section>
      ) : null}
      {loading ? (
        <section className="settings-panel">Loading settings</section>
      ) : null}
      {!loading && activeTab === 'members' ? (
        <section className="settings-panel" aria-label="Workspace members">
          <div className="settings-toolbar">
            <label>
              Invite role
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as WorkspaceInviteRole)}>
                {inviteRoles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            <button type="button" onClick={createInvite}>Create invite</button>
          </div>
          {createdKey ? (
            <label className="settings-secret">
              Invite token
              <input readOnly value={createdKey.token} />
            </label>
          ) : null}
          <div className="settings-table" role="table" aria-label="Workspace members">
            <div role="row" className="settings-row settings-heading">
              <span role="columnheader">Name</span>
              <span role="columnheader">Email</span>
              <span role="columnheader">Role</span>
              <span role="columnheader">Actions</span>
            </div>
            {members.map((member) => (
              <div role="row" className="settings-row" key={member.userId}>
                <span role="cell">{member.displayName}</span>
                <span role="cell">{member.email ?? '-'}</span>
                <span role="cell">
                  <select
                    aria-label={`${member.displayName} role`}
                    data-testid={`role-${member.userId}`}
                    value={roleDrafts[member.userId] ?? member.role}
                    onChange={(event) => changeMemberRole(member.userId, event.target.value as WorkspaceRole)}
                  >
                    {memberRoles.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                </span>
                <span role="cell" className="settings-actions">
                  <button type="button" data-testid={`save-${member.userId}`} onClick={() => updateRole(member)}>Save</button>
                  <button type="button" data-testid={`remove-${member.userId}`} onClick={() => removeMember(member)}>Remove</button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {!loading && activeTab === 'documents' ? (
        <section className="settings-panel" aria-label="Workspace documents">
          <div className="settings-table" role="table" aria-label="Workspace documents">
            <div role="row" className="settings-row settings-heading">
              <span role="columnheader">Document</span>
              <span role="columnheader">Default branch</span>
              <span role="columnheader">Grants</span>
            </div>
            {documents.map((document) => (
              <div role="row" className="settings-row settings-doc-row" key={document.docId}>
                <span role="cell">{document.title}</span>
                <span role="cell">{document.defaultBranchId ?? '-'}</span>
                <span role="cell" className="grant-counts">
                  <span>{document.viewGrantCount} view</span>
                  <span>{document.editGrantCount} edit</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
