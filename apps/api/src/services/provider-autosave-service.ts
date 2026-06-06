import type { CollabSnapshotService } from '../http/app';
import type { DbPool } from '../db/client';
import { persistBranchMarkdownSnapshot } from './version-service';

export const PROVIDER_AUTOSAVE_CHECKPOINT_INTERVAL_MS = 60 * 1000;
export const PROVIDER_AUTOSAVE_BRANCH_QUIET_MS = 30 * 1000;
export const PROVIDER_AUTOSAVE_CHECKPOINT_ACTOR_ID = 'provider-autosave';

export interface ProviderBackedBranch {
  docId: string;
  branchId: string;
}

export interface ProviderAutosaveRunResult {
  checked: number;
  created: number;
  unchanged: number;
  failed: number;
}

export interface ProviderAutosaveRunInput {
  pool: DbPool;
  collabSnapshotService: CollabSnapshotService;
  limit?: number;
  updatedBefore?: Date;
  onError?: (error: unknown, branch?: ProviderBackedBranch) => void;
}

export interface ProviderAutosaveJob {
  runNow(): Promise<ProviderAutosaveRunResult | null>;
  stop(): void;
}

interface ProviderAutosaveJobInput extends ProviderAutosaveRunInput {
  intervalMs?: number;
  shouldRun?: () => boolean;
}

export async function listProviderBackedBranches(
  pool: DbPool,
  options: { limit?: number; updatedBefore?: Date } = {},
): Promise<ProviderBackedBranch[]> {
  const result = await pool.query<{ doc_id: string; branch_id: string }>(
    `select b.doc_id, s.branch_id
       from document_branch_states s
       join document_branches b
         on b.id = s.branch_id
      where b.is_archived = false
        and s.provider_doc_id is not null
        and s.provider_doc_seeded_at is not null
        and s.updated_at <= $2
      order by s.updated_at asc
      limit $1`,
    [
      options.limit ?? 100,
      options.updatedBefore ?? new Date(Date.now() - PROVIDER_AUTOSAVE_BRANCH_QUIET_MS),
    ],
  );

  return result.rows.map((row) => ({
    docId: row.doc_id,
    branchId: row.branch_id,
  }));
}

export async function autosaveProviderBackedBranches(
  input: ProviderAutosaveRunInput,
): Promise<ProviderAutosaveRunResult> {
  const listOptions: { limit?: number; updatedBefore?: Date } = {};
  if (input.limit !== undefined) listOptions.limit = input.limit;
  if (input.updatedBefore !== undefined) listOptions.updatedBefore = input.updatedBefore;
  const branches = await listProviderBackedBranches(input.pool, listOptions);
  const result: ProviderAutosaveRunResult = {
    checked: branches.length,
    created: 0,
    unchanged: 0,
    failed: 0,
  };

  for (const branch of branches) {
    try {
      const snapshot = await input.collabSnapshotService.readCurrentMarkdownSnapshot(branch);
      if (!snapshot) {
        result.unchanged += 1;
        continue;
      }
      const saved = await persistBranchMarkdownSnapshot({
        pool: input.pool,
        docId: branch.docId,
        branchId: branch.branchId,
        markdown: snapshot.markdown,
        hash: snapshot.hash,
        yjsState: snapshot.yjsState,
        operation: 'autosave',
        actorType: 'system',
        actorId: PROVIDER_AUTOSAVE_CHECKPOINT_ACTOR_ID,
      });
      if (saved.createdVersion) result.created += 1;
      else result.unchanged += 1;
    } catch (error) {
      result.failed += 1;
      input.onError?.(error, branch);
    }
  }

  return result;
}

export function startProviderAutosaveCheckpointJob(input: ProviderAutosaveJobInput): ProviderAutosaveJob {
  let running = false;
  let stopped = false;
  const intervalMs = input.intervalMs ?? PROVIDER_AUTOSAVE_CHECKPOINT_INTERVAL_MS;

  const runNow = async (): Promise<ProviderAutosaveRunResult | null> => {
    if (running || stopped) return null;
    if (input.shouldRun && !input.shouldRun()) return null;
    running = true;
    try {
      return await autosaveProviderBackedBranches(input);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runNow().catch((error) => input.onError?.(error));
  }, intervalMs);
  timer.unref?.();

  return {
    runNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
