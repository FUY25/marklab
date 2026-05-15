import { MARKLAB_API_URL } from './collab-session';

export type WorkspaceRole = 'Owner' | 'Member' | 'Reader';
export type WorkspaceInviteRole = 'Member' | 'Reader';

export interface WorkspaceMember {
  userId: string;
  email: string | null;
  displayName: string;
  role: WorkspaceRole;
}

export interface WorkspaceShareKey {
  keyId: string;
  token: string;
  role: WorkspaceRole;
  expiresAt: string | null;
}

export interface WorkspaceDocument {
  docId: string;
  title: string;
  defaultBranchId: string | null;
  viewGrantCount: number;
  editGrantCount: number;
}

export interface WorkspaceSettingsClient {
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  createShareKey(workspaceId: string, input: { role: WorkspaceInviteRole; expiresAt?: string | null }): Promise<WorkspaceShareKey>;
  updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  listDocuments(workspaceId: string): Promise<WorkspaceDocument[]>;
}

export interface WorkspaceSettingsClientOptions {
  apiUrl?: string;
  fetcher?: typeof fetch;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const body = await readJson(response);
  if (!response.ok) {
    const code =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `http_${response.status}`;
    throw new Error(code);
  }
  return body;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`);
  return value as Record<string, unknown>;
}

function workspaceApiPath(workspaceId: string, suffix: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

function withApiUrl(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/u, '')}${path}`;
}

export function createWorkspaceSettingsClient(options: WorkspaceSettingsClientOptions = {}): WorkspaceSettingsClient {
  const apiUrl = options.apiUrl ?? MARKLAB_API_URL;
  const fetcher = options.fetcher ?? fetch;

  async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetcher(withApiUrl(apiUrl, path), {
      credentials: 'include',
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    return readJsonResponse(response);
  }

  return {
    async listMembers(workspaceId) {
      const body = requireRecord(await requestJson(workspaceApiPath(workspaceId, '/members')), 'members_response');
      return body.members as WorkspaceMember[];
    },
    async createShareKey(workspaceId, input) {
      const body = requireRecord(await requestJson(workspaceApiPath(workspaceId, '/share-keys'), {
        method: 'POST',
        body: JSON.stringify({
          role: input.role,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        }),
      }), 'share_key_response');
      return body.key as WorkspaceShareKey;
    },
    async updateMemberRole(workspaceId, userId, role) {
      const body = requireRecord(await requestJson(workspaceApiPath(workspaceId, `/members/${encodeURIComponent(userId)}`), {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }), 'member_response');
      return body.member as WorkspaceMember;
    },
    async removeMember(workspaceId, userId) {
      await requestJson(workspaceApiPath(workspaceId, `/members/${encodeURIComponent(userId)}`), {
        method: 'DELETE',
      });
    },
    async listDocuments(workspaceId) {
      const body = requireRecord(await requestJson(workspaceApiPath(workspaceId, '/documents')), 'documents_response');
      return body.documents as WorkspaceDocument[];
    },
  };
}
