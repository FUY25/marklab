import { describe, expect, it } from 'vitest';
import type { DbExecutor } from '../db/client';
import { requireUserDocumentAccess } from './control-plane-access';

function createAccessPool(
  role: 'Owner' | 'Member' | 'Reader' | null,
  ownerId: string | null = null,
  workspaceId: string | null = 'ws_1',
): DbExecutor {
  return {
    async query<Row = unknown>() {
      return {
        rows: [{
          owner_id: ownerId,
          workspace_id: workspaceId,
          member_role: role,
        } as Row],
        rowCount: 1,
      };
    },
  };
}

describe('control-plane document access', () => {
  it('allows Reader members to read but not issue edit access', async () => {
    await expect(requireUserDocumentAccess(createAccessPool('Reader'), {
      userId: 'user_reader',
      docId: 'doc_1',
      branchId: 'branch_1',
      operation: 'read',
    })).resolves.toEqual({
      actorType: 'user',
      actorId: 'user_reader',
      canManageAccess: false,
      role: 'view',
    });

    await expect(requireUserDocumentAccess(createAccessPool('Reader'), {
      userId: 'user_reader',
      docId: 'doc_1',
      branchId: 'branch_1',
      operation: 'write',
    })).rejects.toThrow('forbidden');
  });

  it('allows Owners and document owners to write', async () => {
    await expect(requireUserDocumentAccess(createAccessPool('Owner'), {
      userId: 'user_owner',
      docId: 'doc_1',
      branchId: 'branch_1',
      operation: 'write',
    })).resolves.toMatchObject({ actorType: 'user', actorId: 'user_owner', canManageAccess: true, role: 'edit' });

    await expect(requireUserDocumentAccess(createAccessPool(null, 'user_owner', null), {
      userId: 'user_owner',
      docId: 'doc_1',
      branchId: 'branch_1',
      operation: 'write',
    })).resolves.toMatchObject({ actorType: 'user', actorId: 'user_owner', canManageAccess: true, role: 'edit' });
  });

  it('does not let stale document owner ids bypass workspace membership revocation', async () => {
    await expect(requireUserDocumentAccess(createAccessPool(null, 'user_owner'), {
      userId: 'user_owner',
      docId: 'doc_1',
      branchId: 'branch_1',
      operation: 'write',
    })).rejects.toThrow('forbidden');
  });
});
