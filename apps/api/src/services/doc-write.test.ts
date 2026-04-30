import { describe, expect, it } from 'vitest';
import { applyEditToMarkdown, assertCanWrite } from './doc-write';

describe('assertCanWrite', () => {
  it('accepts matching base version and hash', () => {
    expect(() => assertCanWrite('ver_a', 'sha256:a', 'ver_a', 'sha256:a')).not.toThrow();
  });

  it('rejects stale base hash', () => {
    expect(() => assertCanWrite('ver_a', 'sha256:b', 'ver_a', 'sha256:a')).toThrow('stale_base_hash');
  });

  it('rejects stale base version', () => {
    expect(() => assertCanWrite('ver_b', 'sha256:a', 'ver_a', 'sha256:a')).toThrow('stale_base_version');
  });
});

describe('applyEditToMarkdown', () => {
  it('applies unique old_string replacement', () => {
    expect(applyEditToMarkdown('A\nold\nB\n', 'old', 'new', false)).toBe('A\nnew\nB\n');
  });

  it('replaces all matches when requested', () => {
    expect(applyEditToMarkdown('old old', 'old', 'new', true)).toBe('new new');
  });

  it('rejects ambiguous matches', () => {
    expect(() => applyEditToMarkdown('old old', 'old', 'new', false)).toThrow('ambiguous_match');
  });

  it('rejects missing old_string matches', () => {
    expect(() => applyEditToMarkdown('old', 'missing', 'new', false)).toThrow('old_string_not_found');
  });
});
