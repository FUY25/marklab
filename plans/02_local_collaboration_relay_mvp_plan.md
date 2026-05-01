# Hosted Relay And Online Local Mirror MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let collaborators join a local-first Markdown collaboration session through hosted relay infrastructure, either in a browser or through their own local file mirror, while keeping the product light and online-only for MVP sync.

**Architecture:** Each participant who wants a local file runs a MarkLab daemon. The hosted service owns access links, session identity, permission checks, revocation, and websocket relay, but it does not become the canonical document store. While connected, daemons and browsers exchange Yjs updates through the relay; each daemon writes accepted updates into its own local Markdown file. When disconnected, that side stops syncing and must choose a base on reconnect instead of using a hidden offline edit queue.

**Tech Stack:** Existing access grants/session identity model, Hocuspocus/Yjs, outbound daemon-to-relay websocket, React share/join UI, local file service from Plan 01.

---

## Product Scope

This plan starts only after Plan 01's local file sync core is working.

Plan 02 supports three participant shapes:

```text
1. Host local file participant
   README.md <-> host daemon <-> relay

2. Browser-only participant
   browser editor <-> relay <-> host daemon

3. Local mirror participant
   collaborator.md <-> collaborator daemon <-> relay <-> host daemon
```

Plan 02 is online-only sync. It does not promise multi-master offline merging. Plan 03 owns reconnect conflicts, choose-side review, and AI prompt assistance.

## Product Principles

- Local Markdown files remain user-visible sources of truth for daemon participants.
- The hosted service is a connection instrument, not the storage owner.
- Any person can join through browser-only mode without installing a local daemon.
- Any person with edit access can choose local mirror mode if they want their own local Markdown file.
- View links remain browser-only in the MVP.
- No offline remote edit queue in Plan 02.
- If a participant daemon is offline, that participant stops syncing.
- On reconnect, if local file and shared session both changed, Plan 03 conflict review decides what to do.
- View/edit access links are still the sharing primitive.
- Sessions have names/colors independent from the link itself.
- Only the host daemon can authorize global relay writes in Plan 02.
- Other daemon participants are online mirrors, not alternate authorities.

## Task 0: Relay Protocol And Authority Contract

This task must be completed before schema or websocket implementation.

Plan 02 uses a host-authority model:

```text
host local file
  -> host daemon
  -> relay room authority
```

Browser-only collaborators and local mirror daemons can propose edits while connected. An edit is accepted only after the host daemon applies the update through the local room, writes the host Markdown file atomically, persists the accepted `sharedRevision` and `sharedHash`, and returns an acknowledgement for that exact proposal. If any step fails or times out, the relay must not broadcast the update as accepted.

Acceptance criteria:

- Browser edit while host daemon is offline is rejected before it mutates global relay room state.
- Browser edit while host daemon is online is not considered accepted until the host daemon acknowledges it was written into the host local state.
- Local mirror daemon edits are gated the same way.
- Host daemon shutdown freezes write admission before remote updates can slip through.
- The relay never treats its ephemeral Yjs cache as canonical.
- No authority handoff exists in Plan 02. If host leaves, global editing pauses.
- Host file write failure leaves `sharedRevision` unchanged and sends no accepted broadcast.
- Host shutdown after proposal forwarding but before acknowledgement returns `host_offline` or a retryable rejection.

Suggested relay room state machine:

```text
starting
  -> host_online
  -> host_offline
  -> ended
```

Write admission:

```text
host_online + valid edit grant
  -> relay forwards proposed update to host daemon
  -> host daemon applies update to local room
  -> host daemon writes host file
  -> host daemon acks relay with new shared revision/hash
  -> relay broadcasts accepted update to participants

host_offline
  -> reject edit with host_offline
```

The user-visible copy should be simple:

```text
Host offline
Edits resume when the host opens MarkLab again.
```

## Host Online Definition

`Host online` means the host's MarkLab daemon process is running, authenticated to the hosted relay, connected over websocket, and able to write accepted updates to the host local Markdown file.

It does not only mean the host computer is powered on.

MVP implications:

- In CLI alpha, the terminal process that started `marklab open` or `marklab share` must remain running unless the command explicitly daemonizes.
- Closing the browser tab alone does not necessarily stop hosting if the daemon process is still running.
- Closing the terminal process stops hosting unless a future background/menubar daemon owns the process.
- Production can make this feel lighter with a menubar/background process, but the same rule remains: no running host daemon means no global write authority.
- The relay must use heartbeat/lease expiry to mark a host offline when the host daemon disappears, loses network, or stops acking writes.
- Browser edit links and local mirror daemons must treat expired host lease as `host_offline`, not as a chance to let the relay accept writes.

## Mental Model

The product promise is:

```text
MarkLab syncs local Markdown files while collaborators are connected.
```

It is not:

```text
MarkLab automatically merges every offline edit from every local copy.
```

In Plan 02, "local-to-local" means online mirror:

```text
Alice local README.md
  <-> Alice daemon
  <-> hosted relay
  <-> Bob daemon
  <-> Bob local README.md
```

If Bob closes his daemon, Bob's file stops receiving changes. When Bob reopens, he either catches up cleanly or enters Plan 03 review.

If Alice, the host, closes her daemon, Bob does not become the new authority in Plan 02. Bob may continue editing his own local file outside MarkLab sync, but those edits are not global until Alice is online and Plan 03 decides how to reconcile divergence.

## Participant Modes

### Host Local File

Host starts:

```text
marklab open README.md
```

Host can:

- edit in browser;
- edit in local tools;
- create view/edit share links;
- see active sessions;
- revoke links;
- keep local snapshots.

Host daemon responsibilities:

- connect outbound to hosted relay;
- advertise the local room as online;
- bridge local Yjs updates to relay;
- apply relay updates to the local room;
- write accepted changes to the host local file;
- stop accepting remote edits when daemon is shutting down.

### Browser-Only Collaborator

Collaborator opens an edit/view link in a browser.

Editable browser behavior:

- prompts for collaboration name;
- joins relay room;
- receives live document;
- can edit while host session is online;
- does not create a local file;
- sees `Host offline` if host daemon disconnects.

Read-only browser behavior:

- renders selectable Markdown;
- no Hocuspocus edit provider;
- no versions/share controls unless later explicitly allowed.

Browser-only mode matters because a new person should not need local setup to collaborate.

### Local Mirror Collaborator

Collaborator chooses local mode from an edit link or CLI:

```text
marklab join <edit-link> ./README.md
```

Local mirror behavior:

- daemon validates the edit link with hosted relay;
- the link must grant edit access in the MVP;
- daemon validates current `host_online` lease before creating directories, creating files, writing shared content, starting a watcher, or sending a relay proposal;
- if the host is offline, the CLI exits non-zero with `Host offline. Ask the host to open MarkLab again.` and leaves the target path unchanged;
- daemon creates or opens the selected local Markdown file;
- if the local file is empty or unchanged, it writes the current shared session content into it;
- while online, local saves flow to relay and relay updates write to the local file;
- browser can optionally open for the collaborator, but local file sync is the key capability;
- on reconnect with divergent local edits, Plan 03 takes over.

Local mirror target choices:

```text
marklab join <edit-link> ./README.md
```

opens or creates the exact file path.

```text
marklab join <edit-link> --dir ./docs
```

creates a new Markdown file in the selected directory using the shared document title or source basename, for example `./docs/README.md`. If the generated name already exists, the CLI prompts for a new name or accepts `--name`.

```text
marklab join <edit-link> --dir ./docs --name shared-notes.md
```

creates `./docs/shared-notes.md` and starts local mirror sync.

AI agents and local coding assistants can use the same command directly:

```text
marklab join <edit-link> --dir ./docs --name README.md
```

This lets a user tell Codex or Claude Code: "Use this MarkLab edit link and create a synced Markdown file in this folder." The agent should not call hosted write APIs. It should create or edit the local file through the watcher.

Before starting any watcher, local Yjs provider, file write, or relay proposal, `marklab join` must inspect the target path. If the target exists and is non-empty, the daemon creates a pending join conflict candidate and opens Plan 03 conflict review. While this candidate is open, the main editor is read-only and no automatic path may mutate disk, active room state, or relay state.

Plan 02 does not automatically merge offline edits.

## Hosted Relay Responsibilities

Hosted relay owns:

- access grants;
- view/edit roles;
- collaborator sessions;
- display names and colors;
- revocation;
- room online/offline state;
- remote websocket admission;
- routing Yjs updates between connected participants;
- rejecting edit writes when no authority/host session is available;
- tracking accepted shared revisions;
- tracking which grant/session owns each websocket connection.

Hosted relay should not silently persist remote edits as canonical content while no daemon can write them to a local file.

Minimum relay state:

```ts
type RelayRoom = {
  relayRoomId: string;
  hostSessionId: string | null;
  onlineParticipantCount: number;
  lastEphemeralYjsState: Uint8Array | null;
  updatedAt: string;
};
```

`lastEphemeralYjsState` is for fast joins and stale view-only display only. It is not the canonical long-term document store.

Ephemeral cache rules:

- It has an explicit TTL.
- It is labeled stale if rendered while host authority is offline.
- It is not used to accept edits without host acknowledgement.
- Deleting the relay cache never deletes or changes local files.

## Access And Identity

Reuse the Plan 6.7 access/session concepts, but scope them to relay rooms instead of cloud branches.

Do not fake `doc_id` or `branch_id` rows to reuse the old schema.

Required schema direction:

```text
relay_rooms(id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at)
relay_access_grants(id, relay_room_id, token_hash, role, expires_at, revoked_at, created_at)
relay_access_sessions(id, grant_id, client_id, client_kind, display_name, color, last_seen_at, created_at)
```

Acceptance criteria:

- Relay share creation does not insert into `documents`, `document_branches`, `document_branch_states`, or `document_versions`.
- Relay grants are keyed by `relay_room_id`, not `doc_id/branch_id`.
- Relay sessions support `client_kind = browser | daemon | agent`.
- Revoking one relay link closes only sessions using that link.
- Revoking link A does not disconnect link B clients.
- Revoking a collaborator link does not disconnect the host daemon unless the host ends the relay room.

Access link:

```text
role = view | edit
scope = relay room
revoked_at = null | timestamp
```

Session:

```text
client_kind = browser | daemon | agent
display_name
color
last_seen_at
```

One link can have many sessions. Revoking the link ends access for every browser/daemon using that link.

## Sync Semantics

Connected online sync for browser collaborators and local mirror collaborators:

```text
participant local/browser edit
  -> participant Yjs room update
  -> relay receives proposed update
  -> relay forwards to host daemon
  -> host daemon writes host local file
  -> host daemon acks accepted shared revision
  -> relay broadcasts accepted update to connected participants
  -> mirror daemons write their local files
```

Host daemon local file save:

```text
host local file save
  -> watcher applies Markdown to local Yjs room
  -> host daemon writes host local file if needed
  -> host daemon sends accepted update plus shared revision/hash to relay
  -> relay broadcasts accepted update to browsers/other daemons
  -> mirror daemons write their local files
```

Local mirror daemon local file save:

```text
mirror local file save
  -> watcher applies Markdown to mirror local Yjs room
  -> mirror daemon sends proposed update to relay
  -> relay forwards proposed update to host daemon
  -> host daemon applies update and writes host local file
  -> host daemon acks accepted shared revision/hash
  -> relay broadcasts accepted update to connected participants
  -> mirror daemon treats its local save as accepted only after the host ack
```

Host offline:

```text
host daemon disconnects
  -> relay marks host offline
  -> browser edit links show Host offline
  -> local mirror daemons stop receiving/sending accepted global updates
  -> browser/local mirror edits are local-only and not queued as global updates
```

No hidden queue:

```text
offline edit
  -> stays local to that participant
  -> reconnect requires clean catch-up or Plan 03 review
```

## UI

Host Share drawer:

```text
Create view link
Create edit link
Copy link
Active sessions
Revoke
```

Copy:

```text
This link works while collaborators are connected through MarkLab.
```

Remote browser page:

```text
[clean editor or read-only document]
small status: Connected / Host offline
```

Local mirror join flow:

```text
Open this link locally
marklab join <edit-link> ./README.md
marklab join <edit-link> --dir ./docs
marklab join <edit-link> --dir ./docs --name shared-notes.md
```

If local file already exists and is non-empty:

```text
Replace with shared version
Review conflict
Cancel
```

Do not add folders, sidebars, full document managers, branch UI, or cloud document dashboards in Plan 02.

`Use local file` is not a Plan 02 one-click action because it can publish local content to everyone. Non-empty local mirror joins either replace the local file with the host-authorized shared version or enter Plan 03 review.

View-only links do not start a local mirror in the MVP. A view-only user can open the browser read-only page. This avoids confusing "read-only permission" with a local file that the user's editor can freely modify.

## Share State Surfaces

The web Share drawer is the primary human UI for share state. It already shows links, roles, sessions, copy actions, and revoke actions. Plan 02 keeps that direction and removes branch/cloud wording from that surface.

CLI and menubar must expose the same relay share state without inventing a second access model.

CLI read surface:

```text
marklab share-state README.md
marklab share-state README.md --json
```

Required fields:

```ts
type ShareState = {
  localPath: string;
  relayRoomId: string | null;
  hostOnline: boolean;
  hostSessionId: string | null;
  links: Array<{
    grantId: string;
    role: 'view' | 'edit';
    label: string | null;
    canCopyExistingUrl: boolean;
    revokedAt: string | null;
    expiresAt: string | null;
    activeSessionCount: number;
    lastCopiedAt: string | null;
  }>;
  sessions: Array<{
    sessionId: string;
    grantId: string | null;
    clientKind: 'browser' | 'daemon' | 'agent';
    displayName: string;
    role: 'host' | 'view' | 'edit';
    lastSeenAt: string;
  }>;
};
```

`ShareState.links` is a metadata surface, not a raw-secret recovery surface. `create-link` returns the role-specific relay URL once. `share-state` lists grant/session metadata and may include `canCopyExistingUrl: false` when the raw token is not available. Web drawer, CLI, and menubar must share this behavior: inspect/revoke existing grants, create a new grant to get a fresh copyable URL, and never reconstruct URLs from token hashes.

CLI management surface:

```text
marklab create-link README.md --role view
marklab create-link README.md --role edit
marklab revoke-link README.md <grant-id>
```

Acceptance criteria:

- `marklab share-state --json` never includes raw local daemon tokens.
- `marklab share-state --json` never includes raw relay tokens or token hashes.
- Existing grant rows with only `token_hash` report `canCopyExistingUrl: false`.
- Creating a new link returns the raw URL once so the user, CLI, or menubar can copy it immediately.
- View and edit links are visibly distinct in web UI, CLI output, and menubar status.
- Revoking a link disconnects sessions using that grant and leaves unrelated grants plus the host daemon online.
- The host daemon session is shown separately from collaborator sessions.
- CLI link creation uses relay grants, not cloud branch grants.
- Menubar may show share state summary, but detailed link creation/revocation can stay in the browser and CLI.

## Host Command Flow

Plan 02 supports two host entrypoints without ambiguity:

```text
marklab open README.md
```

opens local-only Plan 01 mode. From the local UI, clicking Share upgrades this running local session into a relay-hosted session.

```text
marklab share README.md
```

is shorthand for:

```text
open local file
start relay host session
create or show share controls
print/copy share URL
```

`marklab join <edit-link> ./README.md` is only for local mirror collaborators.

`marklab join` accepts edit links only. View links are browser-only and must be rejected before any local file or directory mutation.

## Relay Transport Decision

Use a separate relay websocket namespace rather than reusing cloud branch persistence.

Recommended:

```text
/relay
room name = relay:<relayRoomId>
```

Reasons:

- `/collab` currently assumes branch-backed persistence and cloud room auth.
- Relay rooms need host-authority write gating before accepted broadcast.
- Relay revocation needs per-grant/per-session connection tracking.
- Relay rooms must not fall through to `document_branch_states`.

If implementation later chooses to reuse Hocuspocus internals, it must still keep this separate persistence/auth/authority contract.

## Conflict Boundary

Plan 02 only detects that reconnect is not clean. It does not solve the conflict.

Clean reconnect:

```text
participant local hash unchanged since disconnect
  -> apply current relay state to local file
  -> continue syncing
```

Divergent reconnect:

```text
participant local hash changed while disconnected
and relay/shared state also changed
  -> pause syncing for that participant
  -> hand off to Plan 03 conflict review
```

This requires persisted local relay join metadata:

```ts
type LocalRelayJoinState = {
  relayRoomId: string;
  grantId: string;
  sessionId: string;
  localDocId: string;
  absolutePath: string;
  lastAcceptedLocalHash: string;
  lastAcceptedSharedHash: string;
  lastAcceptedSharedRevision: number;
  lastHostSessionId: string | null;
  disconnectedCleanly: boolean;
  updatedAt: string;
};
```

## Implementation Tasks

### Task 1: Relay Room Model

**Files:**

- Create: `apps/api/src/relay/relay-room-service.ts`
- Modify: `apps/api/src/db/schema.sql`
- Test: `apps/api/src/relay/relay-room-service.test.ts`

Add a relay-room abstraction separate from cloud `doc_id/branch_id`.

Must include the schema targets in `Access And Identity`, shared revision tracking, host online/offline state, and no cloud document row creation.

### Task 2: Relay WebSocket Bridge

**Files:**

- Create: `apps/api/src/relay/relay-server.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/relay/relay-server.test.ts`

Allow daemon and browser participants to connect to the same relay room and exchange Yjs updates.

Must implement the Task 0 host-authority ack flow. Do not broadcast proposed edits as accepted global state before host acknowledgement.

### Task 3: Local Daemon Relay Client

**Files:**

- Create: `apps/api/src/local/local-relay-client.ts`
- Modify: `apps/api/src/local/local-file-service.ts`
- Modify: `apps/cli/marklab.mjs`

Add:

```text
marklab share ./README.md
marklab join <edit-link> ./README.md
marklab join <edit-link> --dir ./docs
marklab join <edit-link> --dir ./docs --name shared-notes.md
marklab share-state ./README.md --json
marklab create-link ./README.md --role view
marklab create-link ./README.md --role edit
marklab revoke-link ./README.md <grant-id>
```

Keep `marklab open README.md` local-only.

`marklab join` must persist `LocalRelayJoinState` so reconnect detection works after process restart.

Acceptance criteria:

- `marklab join <edit-link> ./README.md` opens or creates the exact target file.
- `marklab join <edit-link> --dir ./docs` creates a target file inside `./docs` using a deterministic safe filename derived from relay metadata.
- `marklab join <edit-link> --dir ./docs --name shared-notes.md` creates exactly `./docs/shared-notes.md`.
- If the target exists and is non-empty, the user sees replace/review/cancel rather than silent overwrite.
- If the target directory does not exist, the CLI creates it only when `--create-dir` is supplied; otherwise it exits with a clear message.
- View links cannot start local mirror join.
- AI agents can run the same CLI command without any separate hosted write/edit API.
- Host-offline `marklab join <edit-link> --dir ./docs --name README.md` creates no file and starts no daemon.
- Host-offline `marklab join` against an existing file leaves bytes unchanged.
- The relay never uses stale `lastEphemeralYjsState` to seed a new local mirror.
- A later successful retry after host returns online creates the file from the current accepted shared revision/hash.
- Existing non-empty target plus `Review conflict` leaves file bytes unchanged until explicit resolution.
- Existing non-empty target plus `Cancel` leaves no relay session and no watcher.
- Existing non-empty target plus `Replace with shared version` requires explicit confirmation and writes only the host-authorized shared revision.
- Main editor is read-only while join conflict review is open.
- `marklab share-state --json` reports host online state, relay room id, links, and sessions without raw local daemon tokens.
- `marklab create-link` creates relay grants and returns the role-specific hosted relay URL.
- `marklab revoke-link` revokes only the selected grant and disconnects only sessions using that grant.

### Task 4: Browser Join Pages

**Files:**

- Create: `apps/web/src/pages/RelayDocumentPage.tsx`
- Modify: `apps/web/src/routes.ts`
- Modify: `apps/web/src/lib/api-client.ts`

Browser links must support view and edit. Edit prompts for a collaborator name.

Relay links route to relay-specific URLs, not `/docs/:docId/branches/:branchId`.

Acceptance criteria:

- View-only relay page does not mount the editable provider.
- View-only relay page reads from host-provided or stale-labeled relay state, not cloud branch `readDocument`.
- Edit relay page mounts relay provider only after edit access is verified.
- No branch drawer, branch switcher, cloud version drawer, or cloud document manager appears.

### Task 5: Share Drawer For Local Files

**Files:**

- Modify: `apps/web/src/pages/LocalDocumentPage.tsx`
- Modify: `apps/web/src/components/ShareDrawer.tsx`
- Modify: `apps/cli/marklab.mjs`

Add Share back only for local relay sessions. Keep cloud/admin-token UI hidden from the default launcher.

Share drawer must create relay grants, not branch grants.

CLI share-state and link management must read and mutate the same relay grant/session model as the Share drawer.

## Gstack Plan Review Closure

Engineering review questions addressed in this revision:

- Relay has a host-authority contract before schema or websocket implementation.
- Proposed edits are not broadcast as accepted state until the host daemon writes/acks.
- Host offline freezes global editing instead of allowing relay-owned writes.
- Host daemon saves and mirror daemon saves have separate sync flows.
- Relay rooms, grants, and sessions are separate from cloud documents and branches.
- Revoking one link closes sessions using that link without affecting unrelated links or the host session.
- Local mirror reconnect divergence is explicitly handed to Plan 03.
- Relay transport uses a separate `/relay` namespace or an equivalent separate auth/persistence contract.
- Host-online means daemon process plus relay connection plus host file write capability, not merely computer power state.
- `marklab join` accepts edit links only and fails closed while host is offline.
- Accepted relay writes require durable host file write and exact proposal acknowledgement before broadcast.
- Non-empty local mirror joins start no watcher and mutate no file before explicit user choice.

## Verification

Manual E2E:

```text
1. Host runs marklab open README.md.
2. Host creates edit link.
3. Browser collaborator opens link and joins as a named collaborator.
4. Browser edit changes host README.md.
5. Host edits README.md in local editor and browser collaborator updates.
6. Second collaborator runs marklab join <edit-link> ./bob.md.
7. Host edit updates bob.md while Bob daemon is online.
8. Bob local edit updates host README.md while both daemons are online.
9. Host revokes link and remote access stops.
10. Stop a daemon and confirm that side stops syncing instead of queueing hidden edits.
```

Automated checks:

```text
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test apps/api/src/relay/relay-room-service.test.ts apps/api/src/relay/relay-server.test.ts
npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/relay-collaboration.spec.ts
git diff --check
```

Required automated coverage:

- relay grants do not create cloud docs/branches/versions;
- no host authority means edit update rejected;
- revoked grant disconnects only matching sessions;
- host local file plus relay plus browser-like Yjs client writes to host temp file;
- two daemon local files mirror online edits both directions;
- stop Bob daemon, edit Bob file, edit host file, reconnect pauses instead of merging;
- host-offline `marklab join <edit-link> --dir ./docs --name README.md` creates no directory, no file, no watcher, and no relay proposal;
- host-offline join against an existing target leaves bytes unchanged;
- existing non-empty target plus Review/Cancel/Replace mutates only after explicit user choice;
- edit relay browser joins by link and changes host file;
- view relay browser opens read-only and never creates an edit provider;
- view relay link cannot start `marklab join` local mirror in the MVP;
- CLI smoke covers `marklab share` and `marklab join`.
