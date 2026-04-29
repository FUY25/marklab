import { describe, expect, it } from 'vitest';
import { applyEditToMarkdown, applyMultiEditToMarkdown, MultiEditConflictError, assertCanWrite } from './doc-write';

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
});

describe('applyMultiEditToMarkdown', () => {
  it('applies ordered exact replacements against the evolving document', () => {
    expect(
      applyMultiEditToMarkdown('A old\nB old\n', [
        { oldString: 'A old', newString: 'A new', replaceAll: false },
        { oldString: 'B old', newString: 'B new', replaceAll: false },
      ]),
    ).toBe('A new\nB new\n');
  });

  it('reports which edit failed without returning a partial document', () => {
    expect.assertions(3);

    try {
      applyMultiEditToMarkdown('A old\n', [
        { oldString: 'A old', newString: 'A new', replaceAll: false },
        { oldString: 'missing', newString: 'new', replaceAll: false },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(MultiEditConflictError);
      expect((error as MultiEditConflictError).message).toBe('old_string_not_found');
      expect((error as MultiEditConflictError).editIndex).toBe(1);
    }
  });

  it('reports ambiguous matches with the failing edit index', () => {
    expect.assertions(4);

    try {
      applyMultiEditToMarkdown('old old', [{ oldString: 'old', newString: 'new', replaceAll: false }]);
    } catch (error) {
      expect(error).toBeInstanceOf(MultiEditConflictError);
      expect((error as MultiEditConflictError).message).toBe('ambiguous_match');
      expect((error as MultiEditConflictError).editIndex).toBe(0);
      expect((error as MultiEditConflictError).matchCount).toBe(2);
    }
  });
});
