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
});
