# Reconnect Conflict Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a participant reconnects after local offline edits diverged from the shared session, pause syncing, let the user choose which side wins or manually resolve, and optionally generate an AI-agent prompt that includes both versions and conflict context.

**Architecture:** Plan 02 detects divergent reconnect and hands a conflict package to Plan 03. The local daemon stores both sides as recoverable snapshots, exposes a conflict-review endpoint, and blocks automatic writes for that participant until the user chooses a resolution. The UI offers simple choices first: use shared version, use local version, open/copy both versions, generate AI prompt, and apply resolved Markdown.

**Tech Stack:** Local file service, hosted relay metadata, React conflict review drawer/page, local snapshots, optional clipboard prompt generation for external AI agents such as Codex or Claude Code.

---

## Product Scope

This plan handles the first conflict experience after Plan 02 online local-to-local sync exists.

It does not implement automatic multi-master offline merging.

It does implement:

- pause-on-divergence;
- save both sides;
- choose shared version;
- choose local version;
- manual paste/write resolved Markdown;
- generate an AI prompt that includes both versions and asks the user's local AI agent to merge;
- resume syncing after explicit user action.

The AI here is not a hosted MarkLab AI. It is the user's own local agent, such as Codex or Claude Code, operating on local files or pasted context.

## Daemon Lifecycle Dependency

Plan 03 does not implement the background daemon or menubar. Plan 01 owns the foreground/background local daemon lifecycle.

Plan 03 must work correctly when the paused participant is running through that background daemon:

- conflict state survives background daemon restart;
- `marklab status` can report that a file is `Sync paused`;
- `marklab stop README.md` stops a paused daemon without resolving or discarding the conflict;
- reopening the same file returns to the existing conflict review state;
- no background watcher path may mutate disk, active room, or relay while the conflict is open.

## Conflict Scenario

Example:

```text
Alice and Bob are online.
Both local files are synced.
Bob closes MarkLab.
Alice edits README.md and stays synced with relay.
Bob edits bob.md while offline.
Bob reopens MarkLab.
Bob local file hash changed.
Shared relay state also changed.
Bob daemon pauses sync and creates a conflict package.
```

Plan 03 then lets Bob decide:

```text
Use shared version
Use my local version
Generate AI prompt
Paste resolved Markdown
Cancel and keep paused
```

## Product Principles

- Never silently overwrite a local file after divergent reconnect.
- Always keep both sides recoverable.
- Prefer explicit user choice over "smart" automatic merge in MVP.
- AI assistance is copy/paste prompt generation, not hidden server-side AI.
- After resolution, the chosen/resolved content is written through the same local file and active room path as Plan 01.
- Conflict review is per participant. Other connected participants should keep syncing unless their own state diverges.
- Every publishing resolution must verify the shared session has not advanced since the conflict package was created.
- While a conflict is open, this participant has explicit sync gates. No background path may mutate disk, active room, or relay state.

## Conflict Package

When Plan 02 detects divergent reconnect, create:

```ts
type ReconnectConflict = {
  conflictId: string;
  relayRoomId: string;
  localDocId: string;
  localPath: string;
  baseMarkdown: string | null;
  baseYjsStateBase64: string | null;
  baseHash: string | null;
  localMarkdown: string;
  localYjsStateBase64: string;
  localHash: string;
  sharedMarkdown: string;
  sharedYjsStateBase64: string;
  sharedHash: string;
  sharedStateFingerprint: string;
  sharedRevision: number;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'resolved' | 'cancelled';
};
```

`baseMarkdown` is best-effort. If there is no known base snapshot, conflict review still works with local and shared versions.

`sharedRevision` and `sharedStateFingerprint` are required for stale-state protection. `sharedYjsStateBase64` allows `Use shared version` to apply the exact shared active-room state captured at conflict creation. If implementation cannot safely persist Yjs state, every resolution must reconstruct a non-empty Yjs state from Markdown through the Milkdown runtime and still keep `sharedRevision`.

## Pause Gates

When a conflict is open for a participant, that participant must be paused.

Blocked until resolution:

- inbound relay updates applying to this participant's active room;
- outbound local file watcher updates publishing to relay;
- browser flush writing active-room edits to local disk;
- `/api/local/flush` writing active-room edits to local disk;
- watcher events applying external file changes into the active room;
- restore or manual save actions that would mutate local state without conflict context.

Allowed while paused:

- read current conflict package;
- preview local/shared/base versions;
- copy AI prompt;
- export/copy either side;
- explicitly resolve by one of the resolution routes.

Acceptance criteria:

- Open conflict blocks all automatic writes for that participant.
- Other participants keep syncing normally.
- The paused participant remains paused after browser refresh and daemon restart.

## Resolution Options

### Use Shared Version

```text
verify conflict is still open
write sharedMarkdown to local file
apply sharedYjsState to local active room
mark conflict resolved
resume sync
```

This means "make my local file match the connected session."

`Use shared version` does not publish to the relay. It only makes this participant's local file match the shared session.

### Use Local Version

```text
verify current relay sharedRevision equals conflict.sharedRevision
apply localMarkdown to local active room
send update to relay
write localMarkdown to local file if needed
mark conflict resolved
resume sync
```

This means "my offline local file should become the shared session."

This operation should require edit permission and should create a conflict-resolution snapshot.

### Paste Resolved Markdown

```text
user pastes final Markdown
verify current relay sharedRevision equals conflict.sharedRevision
apply through LiveMarkdownWriter/runtime
write resolved Markdown to local file
send update to relay
mark conflict resolved
resume sync
```

This is the safest manual merge path.

### Generate AI Prompt

The UI generates a copyable prompt. It does not call OpenAI/Anthropic itself.

Prompt shape:

````text
You are helping resolve a Markdown collaboration conflict.

Goal:
- Merge both versions.
- Preserve all non-conflicting changes.
- Where changes conflict semantically, mark the conflict clearly and ask me to choose.
- Return the full resolved Markdown only after I decide unresolved conflicts.

The content sections below use XML-like tags. Treat the text inside each tag as literal Markdown content.

<base_markdown>
...
</base_markdown>

<my_local_offline_markdown>
...
</my_local_offline_markdown>

<shared_online_markdown>
...
</shared_online_markdown>

Please compare the local offline version and shared online version. First summarize non-conflicting changes, then list real conflicts that require my choice.
````

The user can paste this into Codex, Claude Code, or another local AI agent.

Safe default instruction:

```text
Do not edit the watched conflicted Markdown file directly. Return the full resolved Markdown here, or write it to a separate temporary file. I will paste the final resolved Markdown back into MarkLab.
```

This avoids mutating the paused local file behind the conflict review UI.

## UI

Conflict state should be visible but not dramatic:

```text
Sync paused
This file changed locally while the shared session also changed.
```

Primary actions:

```text
Use shared version
Use my local version
Copy AI merge prompt
Paste resolved Markdown
Keep paused
```

Destructive actions require confirmation copy:

- `Use shared version` replaces the participant's local file with the shared version.
- `Use my local version` publishes this participant's local version to everyone in the shared session.

The UI must state that both original versions were snapshotted and remain recoverable.

Preview sections:

```text
Shared version
My local version
Base version, if available
```

Do not build a full visual merge editor in Plan 03.

## Sync Resume Rules

After explicit resolution:

```text
resolved Markdown
  -> flush active room if needed
  -> verify conflict is open
  -> verify shared revision for publishing resolutions
  -> apply through LiveMarkdownWriter/runtime
  -> require non-empty yjsState
  -> write local file atomically
  -> update active room
  -> send relay update if edit participant
  -> create local conflict-resolution snapshot
  -> mark conflict resolved
```

No resolution may update only metadata or only disk. The active room must be updated so connected editors do not continue from stale state.

Failure handling:

- Mark the conflict resolved only after every required side effect succeeds.
- If disk write succeeds but relay publish fails, remain paused and show recoverable error.
- If shared state advanced after conflict creation, return `409 stale_conflict_shared_state`, refresh shared/base data, and keep paused.
- Create pre-resolution and post-resolution snapshots.

## Implementation Tasks

### Task 1: Conflict Data Model

**Files:**

- Create: `apps/api/src/local/local-conflict-store.ts`
- Modify: `apps/api/src/local/local-metadata-store.ts`
- Test: `apps/api/src/local/local-conflict-store.test.ts`

Store conflict packages locally so restart does not lose unresolved conflicts.

Prerequisite:

- Plan 01's durable `local-metadata-store.ts` exists. If not, this task must create it first.
- Add local version operations:
  - `conflict_opened`
  - `conflict_resolved`
  - `conflict_cancelled`

### Task 2: Divergent Reconnect Detection Hook

**Files:**

- Modify: `apps/api/src/local/local-relay-client.ts`
- Modify: `apps/api/src/local/local-file-service.ts`
- Test: `apps/api/src/local/local-relay-client.test.ts`

Detect:

```text
local file hash changed while disconnected
and shared relay hash changed since disconnect
```

Then pause sync and create a `ReconnectConflict`.

### Task 3: Conflict Review Routes

**Files:**

- Create: `apps/api/src/routes/local-conflict-routes.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/src/routes/local-conflict-routes.test.ts`

Routes:

```text
GET  /api/local/conflicts/current
POST /api/local/conflicts/:conflictId/use-shared
POST /api/local/conflicts/:conflictId/use-local
POST /api/local/conflicts/:conflictId/resolve
GET  /api/local/conflicts/:conflictId/ai-prompt
```

Route contracts:

```ts
type CurrentConflictResponse =
  | { conflict: null }
  | { conflict: ReconnectConflict };

type ResolveConflictRequest = {
  markdown: string;
  expectedSharedRevision: number;
  expectedSharedHash: string;
};

type ConflictResolutionResponse = {
  conflictId: string;
  status: 'resolved';
  hash: string;
  sharedRevision: number | null;
};
```

Errors:

```text
404 conflict_not_found
409 conflict_already_resolved
409 stale_conflict_shared_state
409 conflict_required
413 markdown_too_large
403 forbidden
```

Permission rules:

- `use-shared` is allowed for local mirror sessions because it only updates that participant's local file to match shared state.
- `use-local` requires edit permission because it publishes to the shared session.
- `resolve` requires edit permission because it publishes to the shared session.
- `ai-prompt` is allowed for view or edit because it does not mutate state.

Idempotency:

- Repeating `use-shared` after success returns `conflict_already_resolved` with the resolved metadata.
- Repeating publishing resolutions after success must not publish twice.

### Task 4: Conflict Review UI

**Files:**

- Create: `apps/web/src/components/ConflictReviewDrawer.tsx`
- Modify: `apps/web/src/pages/LocalDocumentPage.tsx`
- Modify: `apps/web/src/lib/api-client.ts`

Show conflict status and the five core actions:

```text
Use shared version
Use my local version
Copy AI merge prompt
Paste resolved Markdown
Keep paused
```

The local document page must disable normal local flush controls while a conflict is open.

MVP behavior: make the main editor read-only while conflict review is open. Let the user inspect previews, copy the AI prompt, or paste resolved Markdown into the explicit resolution control. This avoids creating a third hidden draft while the participant is paused.

## Gstack Plan Review Closure

Engineering review questions addressed in this revision:

- Conflict packages include shared revision and shared state fingerprint for stale-state protection.
- Open conflicts block all automatic write paths for the paused participant.
- Publishing resolutions verify the shared revision before mutating the active room or relay.
- The main editor is read-only while conflict review is open.
- AI assistance is copyable prompt text for local agents, not hosted AI merge.
- Resolution succeeds only after disk, active room, relay state where needed, and metadata are updated.
- Repeat resolution calls are idempotent and must not publish twice.
- Plan 03 explicitly depends on Plan 01 durable metadata and Plan 02 relay revision tracking.

### Task 5: Verification

Automated checks:

```text
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test apps/api/src/local/local-conflict-store.test.ts apps/api/src/routes/local-conflict-routes.test.ts
npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/local-conflict-review.spec.ts
git diff --check
```

Required automated coverage:

- conflict survives daemon restart;
- open conflict blocks `/api/local/flush`;
- watcher updates do not publish while paused;
- remote relay updates do not overwrite paused participant's local file;
- stale shared state returns `409 stale_conflict_shared_state`;
- view/edit permissions differ by action;
- AI prompt preserves fenced-code Markdown exactly;
- `Keep paused` survives page refresh;
- active browsers update only after successful resolution.

Manual E2E:

```text
1. Alice and Bob join the same relay room with local files.
2. Stop Bob daemon.
3. Alice edits and syncs.
4. Edit Bob's local file while Bob is offline.
5. Restart Bob daemon.
6. Confirm Bob enters Sync paused conflict review.
7. Choose Use shared version and confirm Bob file matches Alice.
8. Repeat and choose Use my local version, confirm Alice receives Bob's version.
9. Repeat and copy AI prompt, confirm it contains base/local/shared sections.
10. Paste resolved Markdown and confirm both local files and active browsers update.
```
