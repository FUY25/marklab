// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistedEditSession,
  clearPersistedEditSessionAndCache,
  cleanupStalePersistedEditSessions,
  loadPersistedEditSession,
  persistedEditSessionStorageKey,
  persistEditSession,
} from './edit-session-storage';
import { activeEditSessionWireFixture } from '@marklab/collab-editor';

const storageInput = { docId: 'doc_1', branchId: 'branch_1', token: 'share_token' };

describe('edit session storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('persists refresh metadata without the raw Y-Sweet client token', () => {
    persistEditSession(storageInput, activeEditSessionWireFixture());

    const raw = localStorage.getItem(persistedEditSessionStorageKey(storageInput));
    expect(raw).toBeTruthy();
    expect(raw).toContain('refresh_secret');
    expect(raw).toContain('provider_doc_1');
    expect(persistedEditSessionStorageKey(storageInput)).not.toContain('share_token');
    expect(raw).not.toContain('share_token');
    expect(raw).not.toContain('raw_ysweet_client_token');
    expect(raw).not.toContain('wss://provider.example');
    expect(loadPersistedEditSession(storageInput)).toEqual({
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
      refreshToken: 'refresh_secret',
      providerDocId: 'provider_doc_1',
    });
  });

  it('does not throw when the real session payload exceeds storage quota', () => {
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(this: Storage, key, value) {
      if (String(key).includes('edit-session')) throw new DOMException('quota', 'QuotaExceededError');
      return Reflect.apply(originalSetItem, this, [key, value]);
    });

    expect(() => persistEditSession(storageInput, activeEditSessionWireFixture())).not.toThrow();
  });

  it('can read a stored session when storage is readable but no longer writable', () => {
    persistEditSession(storageInput, activeEditSessionWireFixture());
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(this: Storage, key, value) {
      if (String(key).includes('storage-probe')) throw new DOMException('quota', 'QuotaExceededError');
      return Reflect.apply(originalSetItem, this, [key, value]);
    });

    expect(loadPersistedEditSession(storageInput)).toEqual({
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
      refreshToken: 'refresh_secret',
      providerDocId: 'provider_doc_1',
    });
  });

  it('degrades when browser storage access is blocked', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(() => loadPersistedEditSession(storageInput)).not.toThrow();
    expect(loadPersistedEditSession(storageInput)).toBeNull();
    expect(() => persistEditSession(storageInput, activeEditSessionWireFixture())).not.toThrow();
    expect(() => clearPersistedEditSession(storageInput)).not.toThrow();
  });

  it('clears terminal edit sessions together with their IndexedDB provider cache', () => {
    persistEditSession(storageInput, activeEditSessionWireFixture());
    const deletedIndexedDbNames: string[] = [];

    clearPersistedEditSessionAndCache(storageInput, {
      deleteIndexedDb(name) {
        deletedIndexedDbNames.push(name);
      },
    });

    expect(localStorage.getItem(persistedEditSessionStorageKey(storageInput))).toBeNull();
    expect(deletedIndexedDbNames).toEqual(['marklab:collab-web:provider_doc_1:session_1']);
  });

  it('prunes stale persisted edit sessions and their matching IndexedDB cache names', () => {
    const freshInput = { docId: 'doc_fresh', branchId: 'branch_fresh', token: 'fresh_token' };
    const staleKey = persistedEditSessionStorageKey(storageInput);
    const freshKey = persistedEditSessionStorageKey(freshInput);
    localStorage.setItem(staleKey, JSON.stringify({
      version: 1,
      docId: storageInput.docId,
      branchId: storageInput.branchId,
      routeTokenHash: 'shared',
      sessionId: 'session_stale',
      refreshToken: 'refresh_stale',
      providerDocId: 'provider_stale',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }));
    localStorage.setItem(freshKey, JSON.stringify({
      version: 1,
      docId: freshInput.docId,
      branchId: freshInput.branchId,
      routeTokenHash: 'shared',
      sessionId: 'session_fresh',
      refreshToken: 'refresh_fresh',
      providerDocId: 'provider_fresh',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }));
    localStorage.setItem('unrelated', 'keep');
    const deletedIndexedDbNames: string[] = [];

    const result = cleanupStalePersistedEditSessions({
      now: new Date('2026-05-22T00:00:00.000Z'),
      maximumAgeMs: 30 * 24 * 60 * 60 * 1000,
      deleteIndexedDb(name) {
        deletedIndexedDbNames.push(name);
      },
    });

    expect(result.removed).toBe(1);
    expect(localStorage.getItem(staleKey)).toBeNull();
    expect(localStorage.getItem(freshKey)).toBeTruthy();
    expect(localStorage.getItem('unrelated')).toBe('keep');
    expect(deletedIndexedDbNames).toEqual(['marklab:collab-web:provider_stale:session_stale']);
  });
});
