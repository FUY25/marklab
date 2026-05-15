// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSettings } from './WorkspaceSettings';
import type { WorkspaceSettingsClient } from '../api/workspace-settings';

function createClient(overrides: Partial<WorkspaceSettingsClient> = {}): WorkspaceSettingsClient {
  return {
    listMembers: vi.fn(async () => [
      { userId: 'user_owner', email: 'owner@example.test', displayName: 'Alice', role: 'Owner' as const },
      { userId: 'user_reader', email: 'reader@example.test', displayName: 'Bob', role: 'Reader' as const },
    ]),
    createShareKey: vi.fn(async () => ({
      keyId: 'wsk_1',
      token: 'ml_workspace_secret',
      role: 'Member' as const,
      expiresAt: null,
    })),
    updateMemberRole: vi.fn(async (_workspaceId, userId, role) => ({
      userId,
      email: 'reader@example.test',
      displayName: 'Bob',
      role,
    })),
    removeMember: vi.fn(async () => undefined),
    listDocuments: vi.fn(async () => [
      {
        docId: 'doc_1',
        title: 'Spec doc',
        defaultBranchId: 'branch_1',
        viewGrantCount: 2,
        editGrantCount: 1,
      },
    ]),
    ...overrides,
  };
}

describe('WorkspaceSettings', () => {
  afterEach(() => {
    cleanup();
  });

  it('lets an owner inspect members, create an invite, change roles, remove members, and inspect document grants', async () => {
    const client = createClient();

    render(<WorkspaceSettings workspaceId="ws_1" client={client} />);

    expect(await screen.findByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(await screen.findByDisplayValue('ml_workspace_secret')).toBeTruthy();
    expect(client.createShareKey).toHaveBeenCalledWith('ws_1', { role: 'Member' });

    fireEvent.change(screen.getByTestId('role-user_reader'), { target: { value: 'Member' } });
    fireEvent.click(screen.getByTestId('save-user_reader'));
    expect(client.updateMemberRole).toHaveBeenCalledWith('ws_1', 'user_reader', 'Member');

    fireEvent.click(screen.getByTestId('remove-user_reader'));
    expect(client.removeMember).toHaveBeenCalledWith('ws_1', 'user_reader');

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    expect(await screen.findByText('Spec doc')).toBeTruthy();
    expect(screen.getByText('2 view')).toBeTruthy();
    expect(screen.getByText('1 edit')).toBeTruthy();
  });

  it('surfaces server 403 responses for reader attempts to mutate settings', async () => {
    const client = createClient({
      createShareKey: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    });

    render(<WorkspaceSettings workspaceId="ws_1" client={client} />);
    await screen.findByText('Alice');

    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));

    expect((await screen.findByRole('status')).textContent).toContain('forbidden');
  });

  it('reverts a role dropdown when the server rejects a member role update', async () => {
    const client = createClient({
      updateMemberRole: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    });

    render(<WorkspaceSettings workspaceId="ws_1" client={client} />);
    await screen.findByText('Bob');

    const roleSelect = screen.getByTestId('role-user_reader') as HTMLSelectElement;
    fireEvent.change(roleSelect, { target: { value: 'Owner' } });
    expect(roleSelect.value).toBe('Owner');

    fireEvent.click(screen.getByTestId('save-user_reader'));

    expect((await screen.findByRole('status')).textContent).toContain('forbidden');
    expect((screen.getByTestId('role-user_reader') as HTMLSelectElement).value).toBe('Reader');
  });
});
