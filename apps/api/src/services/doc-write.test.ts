import { describe, expect, it } from 'vitest';
import { applyEditToMarkdown } from './doc-write';

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
