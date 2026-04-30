import { findEditTarget } from '@marklab/shared/src/edit-ops';

export class EditConflictError extends Error {
  constructor(message: 'old_string_not_found' | 'ambiguous_match', public readonly matchCount?: number) {
    super(message);
    this.name = 'EditConflictError';
  }
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
