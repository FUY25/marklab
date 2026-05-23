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
    getBillingState: vi.fn(async () => ({
      workspaceId: 'ws_1',
      role: 'Owner' as const,
      canManagePlan: false,
      mode: 'manual' as const,
      plan: {
        planId: 'free',
        name: 'Free',
        status: 'manual',
        currentPeriodEnd: null,
      },
      limits: {
        memberSeats: 1,
        concurrentGuestEdits: 3,
      },
      usage: {
        memberSeats: 1,
        concurrentGuestEdits: 2,
      },
      management: {
        stripeConfigured: false,
        canManagePayment: false,
        message: 'Manual/free alpha mode. Stripe and paid-plan changes are not enabled.',
      },
    })),
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

    fireEvent.click(screen.getByRole('button', { name: 'Plan & Billing' }));
    expect(await screen.findByText('Free')).toBeTruthy();
    expect(screen.getByText('manual')).toBeTruthy();
    expect(screen.getByText('1 / 1')).toBeTruthy();
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(screen.getByText('Manual/free alpha mode. Stripe and paid-plan changes are not enabled.')).toBeTruthy();
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

  it('shows a Google sign-in path when the workspace session expires', async () => {
    const client = createClient({
      listMembers: vi.fn(async () => {
        throw new Error('unauthorized');
      }),
    });

    render(<WorkspaceSettings workspaceId="ws_1" client={client} />);

    expect((await screen.findByRole('status')).textContent).toContain('Session expired');
    expect(screen.getByRole('link', { name: 'Continue with Google' }).getAttribute('href')).toBe('/signin?returnTo=%2Fworkspaces%2Fws_1%2Fsettings');
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
