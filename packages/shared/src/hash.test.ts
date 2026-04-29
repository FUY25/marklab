import { describe, expect, it } from 'vitest';
import { sha256Hex, shortHash } from './hash';

describe('sha256Hex', () => {
  it('returns a stable sha256-prefixed hash', () => {
    expect(sha256Hex('hello')).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('shortHash', () => {
  it('returns the first eight hex chars after the prefix', () => {
    expect(shortHash('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')).toBe(
      '2cf24dba',
    );
  });
});
