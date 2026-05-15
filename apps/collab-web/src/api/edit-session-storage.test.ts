// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistedEditSession,
  loadPersistedEditSession,
  persistedEditSessionStorageKey,
  persistEditSession,
} from './edit-session-storage';
import type { ActiveEditSession } from '@marklab/collab-editor';

const storageInput = { docId: 'doc_1', branchId: 'branch_1', token: 'share_token' };

function activeSession(): ActiveEditSession {
  return {
    docId: 'doc_1',
    branchId: 'branch_1',
    sessionId: 'session_1',
    refreshToken: 'refresh_secret',
    providerToken: {
      providerDocId: 'provider_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
      validForSeconds: 600,
      issuedAt: '2026-05-11T00:00:00.000Z',
      expiresAt: '2026-05-11T00:10:00.000Z',
      clientToken: {
        docId: 'provider_doc_1',
        url: 'wss://provider.example/d/provider_doc_1/ws/provider_doc_1',
        baseUrl: 'https://provider.example/d/provider_doc_1',
        token: 'raw_ysweet_client_token',
        authorization: 'full',
      },
    },
  };
}

describe('edit session storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('persists refresh metadata without the raw Y-Sweet client token', () => {
    persistEditSession(storageInput, activeSession());

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

    expect(() => persistEditSession(storageInput, activeSession())).not.toThrow();
  });

  it('can read a stored session when storage is readable but no longer writable', () => {
    persistEditSession(storageInput, activeSession());
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
    expect(() => persistEditSession(storageInput, activeSession())).not.toThrow();
    expect(() => clearPersistedEditSession(storageInput)).not.toThrow();
  });
});
