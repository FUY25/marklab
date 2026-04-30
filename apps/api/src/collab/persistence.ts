import * as Y from 'yjs';
import type { DbExecutor } from '../db/client';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';

export interface ParsedRoomName {
  docId: string;
  branchId: string;
}

export function toRoomName(docId: string, branchId: string): string {
  return `doc:${docId}:branch:${branchId}`;
}

export function parseRoomName(roomName: string): ParsedRoomName {
  const match = /^doc:([^:]+):branch:([^:]+)$/.exec(roomName);
  if (!match?.[1] || !match[2]) throw new Error('invalid_room_name');
  return { docId: match[1], branchId: match[2] };
}

export function createEmptyYjsState(): Uint8Array {
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export interface LoadedYjsState {
  yjsState: Uint8Array | null;
  stateFingerprint: string | null;
}

export interface StoreYjsStateResult {
  stored: boolean;
  stateFingerprint?: string;
}

export async function loadYjsStateWithMetadata(pool: DbExecutor, roomName: string): Promise<LoadedYjsState> {
  const { branchId } = parseRoomName(roomName);
  const result = await pool.query<{ yjs_state?: Buffer; yjs_state_fingerprint?: string }>(
    'select yjs_state, yjs_state_fingerprint from document_branch_states where branch_id = $1',
    [branchId],
  );
  const row = result.rows[0];
  if (!row) return { yjsState: null, stateFingerprint: null };
  const yjsState = row.yjs_state && row.yjs_state.byteLength > 0 ? new Uint8Array(row.yjs_state) : null;

  return {
    yjsState,
    stateFingerprint: row.yjs_state_fingerprint ?? (yjsState ? encodeYjsStateFingerprint(yjsState) : encodeYjsStateFingerprint(new Uint8Array())),
  };
}

export async function loadYjsState(pool: DbExecutor, roomName: string): Promise<Uint8Array | null> {
  const loaded = await loadYjsStateWithMetadata(pool, roomName);
  return loaded.yjsState;
}

export async function storeYjsState(
  pool: DbExecutor,
  roomName: string,
  state: Uint8Array,
  expectedStateFingerprint: string | null,
  expectedYjsState?: Uint8Array | null,
): Promise<StoreYjsStateResult> {
  const { branchId } = parseRoomName(roomName);
  if (expectedStateFingerprint === null) return { stored: false };
  const nextStateFingerprint = encodeYjsStateFingerprint(state);
  const expectedYjsStateBuffer = expectedYjsState ? Buffer.from(expectedYjsState) : null;

  const result = await pool.query<{ yjs_state_fingerprint: string }>(
    `update document_branch_states
       set yjs_state = $2,
           yjs_state_fingerprint = $4,
           updated_at = now()
     where branch_id = $1
       and (
         yjs_state_fingerprint = $3
         or (
           yjs_state_fingerprint is null
           and (
             ($5::bytea is not null and yjs_state = $5)
             or ($5::bytea is null and yjs_state is null)
           )
         )
       )
     returning yjs_state_fingerprint`,
    [branchId, Buffer.from(state), expectedStateFingerprint, nextStateFingerprint, expectedYjsStateBuffer],
  );
  const stateFingerprint = result.rows[0]?.yjs_state_fingerprint;
  if ((result.rowCount ?? 0) > 0 && stateFingerprint !== undefined) {
    return { stored: true, stateFingerprint };
  }
  return { stored: false };
}
