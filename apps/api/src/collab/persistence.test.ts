import { describe, expect, it } from 'vitest';
import type { DbExecutor } from '../db/client';
import { createEmptyYjsState, loadYjsState, parseRoomName, toRoomName } from './persistence';

describe('parseRoomName', () => {
  it('parses doc branch room', () => {
    expect(parseRoomName('doc:doc_abc:branch:br_main')).toEqual({ docId: 'doc_abc', branchId: 'br_main' });
  });

  it('rejects invalid room', () => {
    expect(() => parseRoomName('bad')).toThrow('invalid_room_name');
  });
});

describe('toRoomName', () => {
  it('builds the branch-aware room name', () => {
    expect(toRoomName('doc_abc', 'br_main')).toBe('doc:doc_abc:branch:br_main');
  });
});

describe('createEmptyYjsState', () => {
  it('returns a non-empty valid encoded update', () => {
    expect(createEmptyYjsState().byteLength).toBeGreaterThan(0);
  });
});

describe('loadYjsState', () => {
  it('treats legacy zero-length state as missing', async () => {
    const pool = {
      query: async () => ({ rows: [{ yjs_state: Buffer.alloc(0) }] }),
    };

    expect(await loadYjsState(pool as DbExecutor, 'doc:doc_abc:branch:br_main')).toBeNull();
  });
});
