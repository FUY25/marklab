import { findEditTarget } from '@marklab/shared/src/edit-ops';

export class EditConflictError extends Error {
  constructor(message: 'old_string_not_found' | 'ambiguous_match', public readonly matchCount?: number) {
    super(message);
    this.name = 'EditConflictError';
  }
}

export class MultiEditConflictError extends EditConflictError {
  constructor(
    message: 'old_string_not_found' | 'ambiguous_match',
    public readonly editIndex: number,
    matchCount?: number,
  ) {
    super(message, matchCount);
    this.name = 'MultiEditConflictError';
  }
}

export function assertCanWrite(
  currentVersionId: string,
  currentHash: string,
  baseVersionId: string,
  baseHash: string,
): void {
  if (currentVersionId !== baseVersionId) throw new Error('stale_base_version');
  if (currentHash !== baseHash) throw new Error('stale_base_hash');
}

export function applyEditToMarkdown(
  markdown: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  const target = findEditTarget(markdown, oldString, replaceAll);
  if (target.kind === 'not_found') throw new EditConflictError('old_string_not_found');
  if (target.kind === 'ambiguous') throw new EditConflictError('ambiguous_match', target.count);

  if (replaceAll) return markdown.split(oldString).join(newString);

  const index = target.indexes[0];
  if (index === undefined) throw new EditConflictError('old_string_not_found');
  return markdown.slice(0, index) + newString + markdown.slice(index + oldString.length);
}

export interface MultiEditOperation {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export function applyMultiEditToMarkdown(markdown: string, edits: MultiEditOperation[]): string {
  return edits.reduce((currentMarkdown, edit, editIndex) => {
    try {
      return applyEditToMarkdown(currentMarkdown, edit.oldString, edit.newString, edit.replaceAll);
    } catch (error) {
      if (error instanceof EditConflictError) {
        throw new MultiEditConflictError(
          error.message as 'old_string_not_found' | 'ambiguous_match',
          editIndex,
          error.matchCount,
        );
      }
      throw error;
    }
  }, markdown);
}
