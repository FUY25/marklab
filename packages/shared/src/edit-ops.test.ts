import { describe, expect, it } from 'vitest';
import { applyStringEdit, findEditTarget } from './edit-ops';

describe('findEditTarget', () => {
  it('finds one target', () => {
    expect(findEditTarget('a b c', 'b', false)).toEqual({ kind: 'matched', indexes: [2] });
  });

  it('detects absent target', () => {
    expect(findEditTarget('a b c', 'x', false)).toEqual({ kind: 'not_found' });
  });

  it('detects ambiguity when replaceAll is false', () => {
    expect(findEditTarget('a b a', 'a', false)).toEqual({ kind: 'ambiguous', count: 2 });
  });
});

describe('applyStringEdit', () => {
  it('replaces a unique target', () => {
    expect(applyStringEdit('hello old world', 'old', 'new')).toBe('hello new world');
  });

  it('replaces all targets when replaceAll is true', () => {
    expect(applyStringEdit('old old', 'old', 'new', true)).toBe('new new');
  });

  it('throws on missing oldString', () => {
    expect(() => applyStringEdit('abc', 'xyz', 'x')).toThrow('old_string_not_found');
  });

  it('throws on ambiguous oldString', () => {
    expect(() => applyStringEdit('abc abc', 'abc', 'x')).toThrow('ambiguous_match');
  });
});
