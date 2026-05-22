import { describe, expect, it } from 'vitest';
import { shouldCreateAutosaveVersion, shouldCreateVersionForCurrentHash } from './save-policy';

describe('shouldCreateVersionForCurrentHash', () => {
  it('creates a version when current hash differs from head hash', () => {
    expect(shouldCreateVersionForCurrentHash('sha256:working', 'sha256:head')).toBe(true);
  });

  it('skips version creation when current hash matches head hash', () => {
    expect(shouldCreateVersionForCurrentHash('sha256:same', 'sha256:same')).toBe(false);
  });
});

describe('shouldCreateAutosaveVersion', () => {
  it('allows autosave when dirty and past the throttle window', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:working',
        headHash: 'sha256:head',
        lastAutosaveAt: new Date('2026-04-29T12:00:00Z'),
        now: new Date('2026-04-29T12:10:01Z'),
      }),
    ).toBe(true);
  });

  it('blocks autosave when the branch is clean', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:same',
        headHash: 'sha256:same',
        lastAutosaveAt: null,
        now: new Date('2026-04-29T12:10:01Z'),
      }),
    ).toBe(false);
  });

  it('blocks autosave inside the throttle window', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:working',
        headHash: 'sha256:head',
        lastAutosaveAt: new Date('2026-04-29T12:05:00Z'),
        now: new Date('2026-04-29T12:10:00Z'),
      }),
    ).toBe(false);
  });

  it('blocks the first dirty autosave until the active edit window reaches the cadence or final quiet time', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:working',
        headHash: 'sha256:head',
        lastAutosaveAt: null,
        activeStartedAt: new Date('2026-04-29T12:00:00Z'),
        pendingHashFirstSeenAt: new Date('2026-04-29T12:01:00Z'),
        now: new Date('2026-04-29T12:01:30Z'),
      }),
    ).toBe(false);
  });

  it('allows the first active autosave after ten minutes of editing even without an earlier autosave row', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:working',
        headHash: 'sha256:head',
        lastAutosaveAt: null,
        activeStartedAt: new Date('2026-04-29T12:00:00Z'),
        pendingHashFirstSeenAt: new Date('2026-04-29T12:09:30Z'),
        now: new Date('2026-04-29T12:10:00Z'),
      }),
    ).toBe(true);
  });

  it('allows a final quiet autosave two minutes after the last observed edit even inside the throttle window', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:working',
        headHash: 'sha256:head',
        lastAutosaveAt: new Date('2026-04-29T12:05:00Z'),
        pendingHashFirstSeenAt: new Date('2026-04-29T12:08:00Z'),
        now: new Date('2026-04-29T12:10:00Z'),
      }),
    ).toBe(true);
  });
});
