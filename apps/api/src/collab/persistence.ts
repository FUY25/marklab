import * as Y from 'yjs';
import type { DbExecutor } from '../db/client';

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

export async function loadYjsState(pool: DbExecutor, roomName: string): Promise<Uint8Array | null> {
  const { branchId } = parseRoomName(roomName);
  const result = await pool.query<{ yjs_state?: Buffer }>(
    'select yjs_state from document_branch_states where branch_id = $1',
    [branchId],
  );
  const row = result.rows[0];
  if (!row?.yjs_state || row.yjs_state.byteLength === 0) return null;
  return new Uint8Array(row.yjs_state);
}

export async function storeYjsState(pool: DbExecutor, roomName: string, state: Uint8Array): Promise<void> {
  const { branchId } = parseRoomName(roomName);
  await pool.query(
    `update document_branch_states
       set yjs_state = $2, updated_at = now()
     where branch_id = $1`,
    [branchId, Buffer.from(state)],
  );
}
