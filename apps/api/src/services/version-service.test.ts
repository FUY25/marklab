import { describe, expect, it } from 'vitest';
import type { DbExecutor } from '../db/client';
import { nextVersionNumber } from './version-service';

describe('nextVersionNumber', () => {
  it('starts at 1 when a branch has no versions', async () => {
    const client = {
      query: async () => ({ rows: [{ next_version_number: 1 }] }),
    };

    await expect(nextVersionNumber(client as DbExecutor, 'br_main')).resolves.toBe(1);
  });

  it('uses the next integer returned by the repository', async () => {
    const client = {
      query: async () => ({ rows: [{ next_version_number: '12' }] }),
    };

    await expect(nextVersionNumber(client as DbExecutor, 'br_main')).resolves.toBe(12);
  });
});
