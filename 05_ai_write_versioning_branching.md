# AI Write, Versioning, and Branching

## AI write philosophy

The app does not judge whether AI output is good. Codex/Claude Code handles diff review and accept/reject before the tool call. The app only guarantees that accepted writes are safe, versioned, and reversible.

## Tool model

Use:

```text
read_doc
write_doc
edit_doc
```

No separate `insert_doc` in MVP.

Insertion is represented by edit:

```json
{
  "oldString": "## Risks\n",
  "newString": "## Risks\n\n- Regulatory change may compress margins.\n"
}
```

## Full write safety

Full writes are dangerous because they can overwrite human edits. Therefore `write_doc` requires exact `baseVersionId` and `baseHash` match.

Algorithm:

```ts
export function canApplyFullWrite(currentVersionId: string, currentHash: string, baseVersionId: string, baseHash: string): boolean {
  return currentVersionId === baseVersionId && currentHash === baseHash;
}
```

If the version id differs, reject with `409 stale_base_version`. If the hash differs, reject with `409 stale_base_hash`.

> **Context note:** An earlier route sketch parsed `baseVersionId` but ignored it. That made the API contract misleading. The corrected full-write guard checks both version and hash and returns the current version/hash on conflict.

## Edit safety

Edits are safer because they target a local string. They do not require current hash equality.

Algorithm:

```ts
export function findEditTarget(markdown: string, oldString: string, replaceAll: boolean) {
  const indexes: number[] = [];
  let offset = 0;
  while (true) {
    const index = markdown.indexOf(oldString, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + oldString.length;
  }

  if (indexes.length === 0) return { kind: 'not_found' as const };
  if (!replaceAll && indexes.length > 1) return { kind: 'ambiguous' as const, count: indexes.length };
  return { kind: 'matched' as const, indexes };
}
```

Replacement:

```ts
export function applyStringEdit(markdown: string, oldString: string, newString: string, replaceAll = false): string {
  const target = findEditTarget(markdown, oldString, replaceAll);
  if (target.kind === 'not_found') throw new Error('old_string_not_found');
  if (target.kind === 'ambiguous') throw new Error('ambiguous_match');
  if (replaceAll) return markdown.split(oldString).join(newString);
  const index = target.indexes[0];
  return markdown.slice(0, index) + newString + markdown.slice(index + oldString.length);
}
```

## Applying AI edits to Milkdown state

MVP path:

```text
current canonical Markdown
  -> apply write/edit to Markdown string
  -> parse/replace Milkdown editor state for branch
  -> persist Yjs state
  -> serialize canonical Markdown again
  -> create version
```

This may replace more editor state than a direct ProseMirror transaction. That is acceptable in MVP if it is stable and versioned.

> **Context note:** The rejected shortcut was to update only `document_branch_states.current_markdown/current_hash` and leave live Yjs/ProseMirror state untouched. That shortcut can make online editors stale or let later collaboration persistence overwrite agent changes. The corrected path updates live branch state first and treats the canonical mirror as derived state.

## Version creation rules

Create immutable versions for:

```text
create blank doc
import local .md
AI write_doc
AI edit_doc
manual human save
rollback
branch creation
```

Human live edits do not need a new version on every keystroke. Use debounced autosave versions only if needed:

```text
create autosave version at most once every 10 minutes per active branch
```

## Version DAG

Each version has one parent version.

```text
v1 -> v2 -> v3 -> v4
       \
        v2b -> v2c
```

Branch from version creates a new branch whose initial version content equals the selected version snapshot.

## Rollback semantics

Two operations exist:

### Restore as new version

```text
main: v1 -> v2 -> v3 -> v4 -> v5(content = v2)
```

This is a linear restore.

### Branch from version

```text
main:       v1 -> v2 -> v3 -> v4
new branch:      v2 -> v5 -> v6
```

This is the preferred mental model for “work on a new branch.”

MVP should implement branch-from-version first and can also expose restore-as-new-version as a convenience.

## Archive and deletion

MVP supports archive:

```text
archive branch
archive leaf version
```

Hard delete is deferred until data retention rules are designed. If permanent deletion is added, only allow:

```text
leaf version deletion
or entire branch deletion
```

This prevents broken version graphs.
