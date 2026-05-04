import { describe, expect, it } from 'vitest';
import { sharingBlockReason } from '../src/share-guard';
import type { MarkLabStatusEntry } from '../src/cli-adapter';

function statusEntry(overrides: Partial<MarkLabStatusEntry>): MarkLabStatusEntry {
  return {
    path: '/tmp/Note.md',
    displayName: 'Note.md',
    daemon: 'running',
    mode: 'local',
    syncState: 'synced',
    browserUrl: null,
    pid: 123,
    port: 3011,
    lastSyncAt: null,
    hasConflict: false,
    relayRoomId: null,
    ...overrides,
  };
}

describe('sharingBlockReason', () => {
  it('allows a running synced note', () => {
    expect(sharingBlockReason(statusEntry({}))).toBeNull();
  });

  it('blocks conflicted notes', () => {
    expect(sharingBlockReason(statusEntry({ hasConflict: true }))).toContain('conflict');
  });

  it('blocks paused or offline sync states', () => {
    expect(sharingBlockReason(statusEntry({ syncState: 'paused' }))).toContain('paused');
    expect(sharingBlockReason(statusEntry({ syncState: 'sync_paused' }))).toContain('paused');
    expect(sharingBlockReason(statusEntry({ syncState: 'host_offline' }))).toContain('offline');
  });

  it('does not block a missing daemon because hosting confirmation handles that path', () => {
    expect(sharingBlockReason(statusEntry({ daemon: 'missing', syncState: 'error' }))).toBeNull();
  });
});
