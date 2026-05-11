# Historical cloud-first reference. Superseded by docs/appdesigndoc.md; previous local-first plans are archived under docs/Archive/local-first-plans/.

# AI Write, Versioning, and Branching

## AI write philosophy

The app does not judge whether AI output is good. The model and agent runtime own proposal explanation, review text, and tool permission. MarkLab only guarantees that submitted writes are deterministic, conflict-aware, live-editor synchronized, versioned, and reversible.

MVP does not include AI streaming UX, selection-aware AI commands, or in-app diff UI. `Crepe.Feature.AI` is reference material only.

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

Multiple coherent changes are represented as a guarded `write_doc` with full target Markdown. This keeps the public tool surface small. The backend still applies the resulting target through the minimal transaction live writer, so a full-document API input can become block/range-level live editor transactions.

## Full write safety

Full writes are dangerous because they can overwrite human edits. Therefore `write_doc` requires exact `baseVersionId` and `baseHash` match against the current branch head and the freshly serialized live Milkdown/Yjs state.

Algorithm:

```ts
export function canApplyFullWrite(headVersionId: string, liveHash: string, baseVersionId: string, baseHash: string): boolean {
  return headVersionId === baseVersionId && liveHash === baseHash;
}
```

If the version id differs, reject with `409 stale_base_version`. If the branch head still matches but freshly serialized live Yjs has a different hash from the submitted `baseHash`, reject with `409 live_yjs_state_changed` and require the agent to call `read_doc` again.

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

## Agent review policy

```text
small, low-risk, single-region exact replacement
  -> model may call edit_doc after normal tool permission

meaningful, broad, multi-region, high-stakes, destructive, or user-cautious change
  -> model explains proposed change in chat first
  -> model calls write_doc only after the user proceeds through the agent/tool loop
```

The product server does not persist preview objects, change sets, local proposal snapshots, or accept/reject state in MVP. It reports server-level states such as `written`, `stale_base_version`, `live_yjs_state_changed`, `old_string_not_found`, or `ambiguous_match`.

## Applying AI edits to Milkdown state

MVP path:

```text
current canonical Markdown
  -> apply write/edit to produce target canonical Markdown
  -> parse target Markdown to Milkdown/ProseMirror doc
  -> compare target doc with current live Yjs-bound ProseMirror doc
  -> apply only changed ranges via ProseMirror transactions/Yjs updates
  -> serialize the resulting live doc back to canonical Markdown
  -> return valid encoded Yjs state
  -> update yjs_state/mirror/hash and create version in one transaction
```

This is a live editor writer, not a mirror-only writer. Whole-document live replacement is not acceptable for MVP because it can disrupt collaboration state and hides whether the transaction path works.

> **Context note:** The rejected shortcut was to update only `document_branch_states.current_markdown/current_hash` and leave live Yjs/ProseMirror state untouched. That shortcut can make online editors stale or let later collaboration persistence overwrite agent changes. The corrected path updates live branch state first and treats the canonical mirror as derived state.

The minimal transaction writer does not need to preserve cursor position or support selection-aware AI. Its responsibility is to keep the Yjs-bound editor document, canonical mirror, hash, and version head consistent after accepted writes.

If the writer cannot return valid non-empty encoded Yjs state, the operation fails closed. The API must not create a version or update the mirror from Markdown alone.

## Version creation rules

Create immutable versions for:

```text
create blank doc
import local .md
AI write_doc
AI edit_doc
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
  export/read boundaries create or select a matching system version when the flushed hash differs from branch head

manual save:
  create a version immediately if current_hash differs from the head version hash

autosave:
  create a version at most once every 10 minutes per dirty active branch
  trigger after roughly 30s idle or on blur/page hide

pre-agent checkpoint:
  before an accepted agent edit, if fresh live state differs from the head version hash, create a checkpoint version of the current human state
  before an accepted agent write, create that checkpoint only when the submitted baseHash already matches the freshly serialized live hash
  if write_doc baseHash differs from the freshly serialized live hash, reject instead of checkpointing through the stale base
  then create the AI version with the checkpoint as parent when a checkpoint was created

AI write/edit:
  create a version immediately after the minimal transaction live writer succeeds
```

The pre-agent checkpoint bypasses the autosave throttle. This keeps version history honest for accepted operations: human work that existed before the agent operation is represented as a human/system checkpoint, and the agent version contains only the agent's submitted semantic operation on top of that checkpoint. For full-document `write_doc`, the checkpoint must not silently bridge a stale submitted base; stale live state is a conflict and the agent must reread.

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
