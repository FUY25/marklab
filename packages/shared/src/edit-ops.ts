export type EditTargetResult =
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'matched'; indexes: number[] };

export function findEditTarget(markdown: string, oldString: string, replaceAll: boolean): EditTargetResult {
  if (oldString.length === 0) return { kind: 'not_found' };

  const indexes: number[] = [];
  let offset = 0;

  while (offset <= markdown.length) {
    const index = markdown.indexOf(oldString, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + oldString.length;
  }

  if (indexes.length === 0) return { kind: 'not_found' };
  if (!replaceAll && indexes.length > 1) return { kind: 'ambiguous', count: indexes.length };
  return { kind: 'matched', indexes };
}

export function applyStringEdit(markdown: string, oldString: string, newString: string, replaceAll = false): string {
  const target = findEditTarget(markdown, oldString, replaceAll);
  if (target.kind === 'not_found') throw new Error('old_string_not_found');
  if (target.kind === 'ambiguous') throw new Error('ambiguous_match');

  if (replaceAll) return markdown.split(oldString).join(newString);

  const index = target.indexes[0];
  if (index === undefined) throw new Error('old_string_not_found');
  return markdown.slice(0, index) + newString + markdown.slice(index + oldString.length);
}
