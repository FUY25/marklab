# AI Write, Versioning, and Branching

## AI write philosophy

The app does not judge whether AI output is good. Codex/Claude Code handles diff review and accept/reject outside the app with native local file-edit review over `proposal.md`. The app only guarantees that writes submitted after that review are safe, versioned, and reversible.

MVP does not include AI streaming UX, selection-aware AI commands, or in-app diff UI. `Crepe.Feature.AI` is reference material only.

## Tool model

Use:

```text
read_doc
write_doc
edit_doc
multi_edit_doc
```

No separate `insert_doc` in MVP.

Insertion is represented by edit:

```json
{
  "oldString": "## Risks\n",
  "newString": "## Risks\n\n- Regulatory change may compress margins.\n"
}
```

Multiple targeted replacements are represented as one ordered `multi_edit_doc` operation:

```json
{
  "baseVersionId": "ver_043",
  "edits": [
    {
      "oldString": "Old paragraph A.",
      "newString": "New paragraph A.",
      "replaceAll": false
    },
    {
      "oldString": "Old paragraph B.",
      "newString": "New paragraph B.",
      "replaceAll": false
    }
  ]
}
```

`multi_edit_doc` applies edits sequentially against the evolving canonical Markdown and creates one version. If any edit fails, the operation aborts before the live writer runs, so no partial document update or partial version history is created.

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

`multi_edit_doc` uses the same primitive for each ordered edit. The operation is atomic at the MarkLab API boundary: all exact replacements must be valid before the target Markdown is sent through the live writer.

## Local proposal workflow

The local proposal file is a review surface, not a business operation type.

```text
marklab snapshot create
  -> calls read_doc
  -> writes proposal.md with the current canonical Markdown
  -> writes metadata.json with docId, branchId, baseVersionId, baseVersionNumber, baseHash, createdAt

Codex/Claude Code edits proposal.md natively
  -> user reviews the native local diff
```

No `baseline.md`, `before.md`, or `after.md` is created by default. The native agent file-edit UI already knows the file's initial content and can show the diff from that state.

The online submit mirrors the local action:

```text
native Edit      -> marklab edit_doc with the same oldString/newString
native MultiEdit -> marklab multi_edit_doc with the same ordered edit ops
native Write     -> marklab write_doc from proposal.md
```

The CLI does not return user-level `accepted`, `rejected`, or `noop` states. If the user rejects a local diff, no write/edit command is called. Write/edit commands report server-level states such as `written`, `stale`, `old_string_not_found`, or `ambiguous_match`.

## Applying AI edits to Milkdown state

MVP path:

```text
current canonical Markdown
  -> apply write/edit to produce target canonical Markdown
  -> parse target Markdown to Milkdown/ProseMirror doc
  -> compare target doc with current live Yjs-bound ProseMirror doc
  -> apply only changed ranges via ProseMirror transactions/Yjs updates
  -> serialize the resulting live doc back to canonical Markdown
  -> update mirror/hash
  -> create version
```

This is a live editor writer, not a mirror-only writer. Whole-document live replacement is not acceptable for MVP because it can disrupt collaboration state and hides whether the transaction path works.

> **Context note:** The rejected shortcut was to update only `document_branch_states.current_markdown/current_hash` and leave live Yjs/ProseMirror state untouched. That shortcut can make online editors stale or let later collaboration persistence overwrite agent changes. The corrected path updates live branch state first and treats the canonical mirror as derived state.

The minimal transaction writer does not need to preserve cursor position or support selection-aware AI. Its responsibility is to keep the Yjs-bound editor document, canonical mirror, hash, and version head consistent after accepted writes.

## Version creation rules

Create immutable versions for:

```text
create blank doc
import local .md
AI write_doc
AI edit_doc
AI multi_edit_doc
manual human save
pre-agent checkpoint of dirty human work
autosave checkpoint
rollback
branch creation
```

Human live edits do not need a new version on every keystroke.

```text
Yjs persistence:
  continuous/update-based

canonical mirror:
  update current_markdown/current_hash on a 1-2s debounce after human edits
  flush on blur, tab hide, manual save, export, and agent read/write boundaries

manual save:
  create a version immediately if current_hash differs from the head version hash

autosave:
  create a version at most once every 10 minutes per dirty active branch
  trigger after roughly 30s idle or on blur/page hide

pre-agent checkpoint:
  before an agent write/edit, if branch current_hash differs from the head version hash, create a checkpoint version of the current human state
  then create the AI version with that checkpoint as parent

AI write/edit:
  create a version immediately after the minimal transaction live writer succeeds
```

The pre-agent checkpoint bypasses the autosave throttle. This keeps version history honest: human work that existed before the agent operation is represented as a human/system checkpoint, and the agent version contains only the agent's submitted semantic operation on top of that checkpoint.

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
