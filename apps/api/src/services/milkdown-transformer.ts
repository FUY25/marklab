import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';
import { shouldCreateAutosaveVersion } from './save-policy';
import { createVersionWithClient, type VersionActorType } from './version-service';
import { encodeYjsStateFingerprint } from './yjs-state-fingerprint';

export interface InitializedBranchEditorState {
  yjsState: Uint8Array;
  markdown: string;
  hash: string;
}

export type FlushVersionOperation = 'autosave' | 'manual_save';

export interface FlushVersionActor {
  actorType: VersionActorType;
  actorId?: string | null | undefined;
}

export interface FlushBranchMarkdownMirrorResult {
  branchId: string;
  markdown: string;
  hash: string;
  versionId: string;
  versionNumber: number;
  createdVersion: boolean;
}

const runtime = createHeadlessMilkdownRuntime();

export async function initializeBranchEditorState(markdown: string): Promise<InitializedBranchEditorState> {
  return runtime.initializeFromMarkdown(markdown);
}

async function serializeBranchYjsState(yjsState: Uint8Array) {
  try {
    const serialized = await runtime.serializeYjsState(yjsState);
    if (serialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
    return serialized;
  } catch {
    throw new Error('invalid_live_yjs_state');
  }
}

export async function flushBranchMarkdownMirror(
  pool: DbPool,
  docId: string,
  branchId: string,
  operation: FlushVersionOperation = 'autosave',
  actor: FlushVersionActor = { actorType: 'system' },
): Promise<FlushBranchMarkdownMirrorResult> {
  return withTransaction(pool, async (client) => {
    const state = await client.query<{
      yjs_state: Buffer;
      yjs_state_fingerprint: string | null;
      head_version_id: string | null;
      head_version_number: number | null;
      head_hash: string | null;
    }>(
      `select s.yjs_state,
              s.yjs_state_fingerprint,
              b.head_version_id,
              v.version_number as head_version_number,
              v.hash as head_hash
         from document_branches b
         join document_branch_states s on s.branch_id = b.id
         join document_versions v on v.id = b.head_version_id
        where b.doc_id = $1 and b.id = $2 and b.is_archived = false
        for update of b, s`,
      [docId, branchId],
    );
    const row = state.rows[0];
    if (!row) throw new Error('branch_not_found');
    if (!row.head_version_id || !row.head_version_number || !row.head_hash) throw new Error('branch_head_not_found');

    const serialized = await serializeBranchYjsState(new Uint8Array(row.yjs_state));

    const update = await client.query(
      `update document_branch_states
          set yjs_state = $3,
              yjs_state_fingerprint = $4,
              current_markdown = $5,
              current_hash = $6,
              updated_at = now()
        where branch_id = $1
          and exists (
            select 1
              from document_branches
             where id = $1 and doc_id = $2 and is_archived = false
          )`,
      [
        branchId,
        docId,
        Buffer.from(serialized.yjsState),
        row.yjs_state_fingerprint ?? encodeYjsStateFingerprint(serialized.yjsState),
        serialized.markdown,
        serialized.hash,
      ],
    );
    if ((update.rowCount ?? 1) === 0) throw new Error('branch_not_found');

    if (serialized.hash === row.head_hash) {
      return {
        branchId,
        markdown: serialized.markdown,
        hash: serialized.hash,
        versionId: row.head_version_id,
        versionNumber: row.head_version_number,
        createdVersion: false,
      };
    }

    if (operation === 'autosave') {
      const autosave = await client.query<{ last_autosave_at: Date | string | null }>(
        `select max(created_at) as last_autosave_at
           from document_versions
          where branch_id = $1
            and operation = 'autosave'`,
        [branchId],
      );
      const lastAutosaveAt = autosave.rows[0]?.last_autosave_at;
      if (
        !shouldCreateAutosaveVersion({
          currentHash: serialized.hash,
          headHash: row.head_hash,
          lastAutosaveAt: lastAutosaveAt ? new Date(lastAutosaveAt) : null,
          now: new Date(),
        })
      ) {
        return {
          branchId,
          markdown: serialized.markdown,
          hash: serialized.hash,
          versionId: row.head_version_id,
          versionNumber: row.head_version_number,
          createdVersion: false,
        };
      }
    }

    const version = await createVersionWithClient({
      client,
      docId,
      branchId,
      parentVersionId: row.head_version_id,
      markdown: serialized.markdown,
      hash: serialized.hash,
      actorType: actor.actorType,
      actorId: actor.actorId ?? undefined,
      operation,
    });

    return {
      branchId,
      markdown: serialized.markdown,
      hash: serialized.hash,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      createdVersion: true,
    };
  });
}
