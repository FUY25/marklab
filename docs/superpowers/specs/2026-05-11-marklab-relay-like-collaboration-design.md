# MarkLab Relay-Like Collaboration Design

Date: 2026-05-11

Status: Design approved in brainstorming. This document is the product and architecture specification for the next MarkLab collaboration direction.

## Summary

MarkLab will become a MarkEdit-based local-first Markdown collaboration app with browser participation, Relay-like collaboration primitives, and a MarkLab-owned control plane.

The central product idea remains simple: a normal local `.md` file is the user's document artifact, and MarkLab adds live collaboration, browser access, local app access, offline/reconnect behavior, presence, permissions, and AI-friendly local-file workflows around it.

The major architecture change is that MarkLab should learn from Relay's collaboration engine and server split:

- Use Yjs document replicas and provider-style synchronization instead of host-gated edit proposals.
- Use awareness for presence, collaboration cursors, and selection highlights.
- Use a server-side collaboration provider with durable update/snapshot state so collaborators can edit while the host is offline.
- Add a MarkLab control plane for users, relay/server membership, permissions, share keys, seats, plans, and future billing.
- Keep v1 focused on single Markdown file collaboration, not vault or folder sync.

MarkLab should adopt Relay's collaboration primitives and server architecture patterns, not Relay's full Obsidian product surface.

## Goals

1. Build MarkLab.app on the MarkEdit direction, with a native Markdown editing experience as the primary local app surface.
2. Make both MarkLab.app and browser links official collaboration entry points.
3. Support v1 single Markdown file collaboration.
4. Support offline/reconnect collaboration where a guest can continue editing when the original host app is offline.
5. Show collaboration cursors and selection highlights across participants' screens.
6. Keep the local Markdown file as the user-owned document artifact.
7. Support AI/local-agent workflows through local file edits and CLI-controlled software actions.
8. Add a Relay-like control-plane foundation for login, members, roles, share keys, subscriptions, seat limits, and future billing.
9. Prefer Relay-like server setup and provider-token flow because Relay has already proven this shape for local-first collaborative Markdown.

## Non-Goals For The First Implementation

1. Do not implement vault sync.
2. Do not implement folder tree sync as the collaboration MVP.
3. Do not copy Relay's Obsidian plugin architecture.
4. Do not copy Relay's folder/canvas/attachment sync surface into v1.
5. Do not use the old complex MarkLab three-way conflict review as the first conflict UX.
6. Do not add a hosted AI write API for editing document contents.
7. Do not build full self-serve billing, SSO, enterprise audit logs, or complete team admin UI in the first technical slice.

## Product Scope

### Technical MVP

The technical MVP proves the collaboration engine and local-file workflow:

- One Markdown file per collaboration room.
- MarkLab.app native editor based on MarkEdit/CodeMirror.
- Browser editor as a formal collaborator entry point.
- Yjs provider-style sync.
- Durable server-side collaboration state.
- Offline local editing and reconnect merge.
- Awareness-based presence.
- Remote cursor and selection highlight.
- Local Markdown file projection.
- File watcher ingestion for local edits by humans, AI agents, VS Code, Typora, Vim, Cursor, or other tools.
- Relay-like simple conflict diff between editor/shared contents and local disk contents.
- View/edit share links.
- Session identity for browser, MarkLab.app, local mirror, and agent clients.

### Product MVP

The product MVP includes a control-plane foundation even if the first UI is minimal:

- Users.
- Relay/server/workspace object.
- Members.
- Roles: `Owner`, `Member`, `Reader`.
- Share keys or invite keys.
- Document-level access grants: `view` and `edit`.
- Sessions: browser, app, daemon, agent.
- Provider tokens: short-lived tokens used to connect to the Yjs collaboration provider.
- Plans and seat limits.
- Subscription records.

Billing, plan upgrade UI, SSO, enterprise admin, folder-private UI, and attachment billing may ship later, but the schema and architecture must leave room for them.

## Relay Lessons To Adopt

### Adopt

Relay has already made several choices that fit MarkLab:

- Local-first editing with server-assisted asynchronous collaboration.
- Yjs CRDTs as the merge layer.
- A provider-style sync server instead of peer-to-peer only.
- A control plane that issues document-scoped provider tokens.
- A separation between collaboration transport and login/permission management.
- Awareness for presence, cursors, and selection highlights.
- CodeMirror binding to Y.Text for native Markdown editing.
- Local persistence and stale disk detection.
- Simple diff-based conflict UX.
- Server deployment choices that separate collaboration provider, control plane, and storage.

### Do Not Adopt In V1

Relay also includes product surfaces that should not enter MarkLab v1:

- Obsidian vault and folder sharing.
- File tree metadata sync.
- Rename/delete/download/upload folder reconciliation.
- Obsidian `TextFileView`, `MarkdownView`, and plugin lifecycle patching.
- Canvas sync.
- Attachment storage and quotas in the first collaboration slice.
- Relay's proprietary login, permissions, and billing implementation.

### Implement Ourselves

Relay's open client/plugin code and Y-Sweet-style architecture are valuable references. Its login, permission, and billing server code is proprietary, so MarkLab must implement its own control plane.

The correct framing is:

> Borrow Relay's open collaboration architecture and implementation patterns; implement MarkLab's own control plane, permissions, product UI, and business system.

## Architecture

```text
MarkLab.app
  MarkEdit-based CodeMirror editor
  local Y.Doc / Y.Text
  local file projection
  local persistence
  share/manage UI

Browser editor
  CodeMirror preferred
  Y.Doc / Y.Text
  IndexedDB persistence
  view/edit link join

MarkLab Control Plane
  users
  relays / workspaces / servers
  members
  roles
  share keys
  access grants
  sessions
  plans
  seat limits
  subscription records
  provider token minting

MarkLab Collaboration Provider
  Yjs sync websocket
  document-scoped token validation
  update log
  periodic snapshots
  awareness fanout
  reconnect support

Storage
  Postgres for metadata
  Postgres or object storage for Yjs update/snapshot data
  object storage later for attachments
```

The first deploy can still be one Fly app plus Neon Postgres. Internally, however, the code should be organized around the control-plane/provider/storage split so it can later scale or be self-hosted like Relay.

## Server Model

### Current MarkLab Alpha

The current alpha uses:

- One Fly app for web, API, and `/relay` websocket.
- Neon Postgres for room metadata, grants, sessions, host state, revision/hash, and ephemeral Yjs state.
- A host-gated protocol where browser edits are proposed to the host daemon and accepted only after host acknowledgement.

This is useful for the alpha, but it does not satisfy the next product requirement: guest editing while the host is offline.

### Target Server Model

MarkLab should move to a Relay-like server model:

- Control plane authenticates users, checks permissions, and mints short-lived provider tokens.
- Collaboration provider accepts those provider tokens and speaks a Yjs sync protocol.
- Provider persists Yjs updates and snapshots durably.
- Awareness remains ephemeral and is relayed live.
- Clients can reconnect and fetch missing updates even when another participant is offline.

The host no longer approves every edit. The host is one client with a local Markdown projection and owner/admin controls.

### Deployment Phases

Phase 1 can use existing infrastructure:

- One Fly app.
- Neon Postgres.
- Web, control-plane API, and Yjs provider running in one process if needed.
- Single machine only, with sticky routing not required if there is only one machine.

Phase 2 separates internal components:

- Web/static serving.
- Control-plane API.
- Collaboration provider.
- Background compaction/cleanup worker.
- Object storage for snapshots or attachments if Postgres becomes insufficient.

Phase 3 supports team and self-host needs:

- Dedicated collaboration provider deployment.
- Self-hosted provider option.
- Cloud control plane issuing provider tokens.
- Enterprise path for fully self-hosted control plane.

This mirrors Relay's mature shape while preserving MarkLab's own product and infrastructure.

## Data Model

The data model should support the later team/business product even when v1 UI is small.

### Control Plane Entities

- `users`: logged-in people.
- `relays` or `workspaces`: top-level collaboration server/workspace object.
- `relay_members`: users inside a relay/workspace.
- `roles`: `Owner`, `Member`, `Reader`.
- `share_keys`: invite keys for joining a relay/workspace.
- `documents`: one Markdown document resource for v1.
- `document_access_grants`: view/edit links.
- `sessions`: browser/app/daemon/agent participant sessions.
- `plans`: free/dev/team/business plan definitions.
- `seat_limits`: max users/devices per plan.
- `subscriptions`: subscription records, initially manual or free-only.
- `provider_tokens`: short-lived token issuance records or verifiable token metadata.

### Collaboration Provider Entities

- `collab_documents`: provider document id, current snapshot pointer, revision.
- `collab_updates`: ordered Yjs update log.
- `collab_snapshots`: compacted Yjs state snapshots.
- `collab_clients`: optional reconnect/client bookkeeping.
- `collab_awareness`: not persisted as document history; relayed in memory only.

### Local App Entities

- Local file path.
- Last projected Markdown hash.
- Last projected Yjs state fingerprint.
- Local disk buffer for stale conflict detection.
- Local client id/session id.
- Local persistence store for offline app state.

## Permission Model

MarkLab should distinguish access, identity, and presence:

- Access link or membership defines what a participant is allowed to do.
- Session identity defines who appears in the document.
- Presence defines where that session's cursor/selection is.

Initial roles:

- `Owner`: manages document, members, links, share keys, billing/subscription later.
- `Member`: can edit shared resources they have access to and participate normally.
- `Reader`: can view but not edit.

Initial grant roles:

- `view`: read-only browser/app access.
- `edit`: collaborative editing access.

Provider tokens must be short-lived and document-scoped. A permanent share link must not directly be the provider write credential. The flow should be:

1. User or guest opens a share link.
2. Control plane validates link, membership, expiry, revocation, seat rules, and role.
3. Control plane creates or updates a session.
4. Control plane issues a short-lived provider token.
5. Client connects to the collaboration provider with that token.

This follows Relay's token pattern and avoids making long-lived share URLs equivalent to raw websocket write credentials.

## Collaboration Data Flow

### Create And Share

1. User opens a local Markdown file in MarkLab.app.
2. MarkLab creates a local Y.Doc and imports the Markdown into Y.Text.
3. MarkLab creates a control-plane document resource.
4. MarkLab creates or selects a relay/workspace context.
5. MarkLab uploads initial Yjs state or initial update set to the collaboration provider.
6. User creates view/edit share links or share keys.
7. Control plane stores grants and returns safe URLs.

### Browser Join

1. Browser opens a share URL.
2. Control plane validates link and creates a session.
3. Browser receives a short-lived provider token.
4. Browser creates a Y.Doc and connects to the provider.
5. Provider syncs document updates.
6. Browser shows editor or read-only view according to role.
7. Browser stores local Yjs persistence in IndexedDB for offline/reconnect.

### MarkLab.app Join

1. User opens a share link in MarkLab.app.
2. App validates access through the control plane.
3. App chooses or creates a local Markdown file projection.
4. App creates a local Y.Doc, connects to provider, and syncs.
5. App writes synced content to local Markdown after safe debounce/projection.
6. If local disk diverges from shared editor state, app opens Relay-like conflict diff.

### Offline Guest Editing

1. Guest app/browser loses network or the host app is offline.
2. Guest continues editing against local Y.Doc.
3. Local persistence stores Yjs updates.
4. On reconnect, provider receives the updates.
5. Provider merges them through Yjs.
6. Other clients receive the merged result when they reconnect.

This is the primary reason MarkLab must move away from host-gated proposals.

### Host Reconnect

1. Host MarkLab.app reconnects and fetches provider updates.
2. App compares shared Y.Text state against local disk projection.
3. If local disk did not diverge, app updates the `.md` projection.
4. If local disk changed independently, app shows a Relay-like diff conflict.
5. User chooses keep editor/shared contents or accept local disk.

## Local File And AI Workflow

The local Markdown file remains a first-class product object.

AI agents and local tools should edit the `.md` file directly when a local file exists. The CLI controls software actions such as share, revoke, export, status, wait-for-sync, and conflict inspection. AI should not write through a hosted content mutation API.

When the local file changes:

1. File watcher detects disk change.
2. MarkLab compares the new disk contents to the last projected disk buffer.
3. If the shared Y.Text state did not diverge, MarkLab applies a text diff into Y.Text.
4. If both disk and shared state diverged, MarkLab opens conflict diff.
5. After resolution, MarkLab projects the chosen content back to disk and provider state.

An explicit agent edit protocol can be added later:

- `marklab agent edit begin`
- `marklab agent edit end`
- `marklab status`
- `marklab wait-for-sync`
- `marklab conflict`

The first implementation can rely on file watcher ingestion, but the architecture should leave room for explicit begin/end coordination if realtime file edits produce noisy conflict behavior.

## Editor Choice

MarkLab.app should use CodeMirror + Y.Text because MarkEdit is already CodeMirror-oriented and Relay's native collaboration path is CodeMirror-oriented.

The browser editor should also move toward CodeMirror if practical. Keeping browser on Milkdown while MarkLab.app uses CodeMirror creates extra adapters for:

- Markdown serialization.
- Cursor and selection mapping.
- Yjs text binding.
- Conflict diff.
- AI/local file patches.

If browser remains Milkdown temporarily, it must use the same shared document model and awareness schema as MarkLab.app. The browser/Milkdown path should be treated as transitional, not the long-term foundation.

## Cursor And Highlight Requirement

Collaboration cursor and selection highlight are v1 requirements.

Required behavior:

- If Alice places a cursor, Bob sees Alice's caret and label/color.
- If Alice selects text, Bob sees the selected range highlighted.
- Multi-line selection is rendered clearly.
- Cursor and highlight follow concurrent edits without obvious drift.
- Cursor disappears or becomes inactive when the participant disconnects, blurs, or leaves the document.
- Colors are stable per participant/session.
- Both MarkLab.app and browser editor support the same behavior.

Awareness schema:

```ts
awareness.setLocalStateField("user", {
  id: sessionId,
  name,
  color,
  colorLight,
});

awareness.setLocalStateField("cursor", {
  anchor: Y.createRelativePositionFromTypeIndex(ytext, selection.anchor),
  head: Y.createRelativePositionFromTypeIndex(ytext, selection.head),
});
```

The important implementation detail is Yjs relative positions. MarkLab should not use raw absolute offsets for cross-client cursor state because offsets drift under concurrent edits.

## Conflict UX

The first conflict UX should be Relay-like and intentionally simple.

Conflict state:

- Editor/shared contents.
- Local disk contents.
- Last projected disk buffer or last synced baseline for comparison.

User choices:

- Keep editor contents.
- Accept local disk contents.
- Later: hunk-level accept.
- Later: AI-assisted merge.

The old MarkLab three-way conflict UI with base/local/shared/AI merge is deferred. It remains a possible future upgrade, but it should not block the collaboration MVP.

Conflict principles:

- Never silently overwrite local disk changes.
- Never silently discard provider/editor changes.
- Show the diff before asking for a decision.
- Apply the chosen resolution to both local projection and shared Yjs state.
- Record a version/snapshot when resolving if versioning is available.

## Error Handling

### Auth And Permission Errors

- Expired provider token: client requests a fresh token from control plane.
- Revoked link: provider disconnects the client and editor becomes read-only or unavailable.
- Seat limit exceeded: control plane blocks new member/session according to plan policy.
- Role downgrade: provider stops accepting writes from that session after token refresh or active disconnect.

### Network Errors

- Browser and app continue local editing if they have local persistence and edit permission.
- UI shows reconnecting/offline state.
- Provider sync resumes when network returns.
- Awareness is allowed to disappear during disconnect and return later.

### Local File Errors

- Missing local file: MarkLab pauses local projection and asks user to locate, recreate, or detach the local projection.
- Disk write failure: MarkLab keeps Yjs state, marks local projection unsaved, and surfaces a clear error.
- External disk edit during remote sync: MarkLab opens conflict diff if automatic diff application is unsafe.

### Provider Errors

- Snapshot load failure: provider refuses document connection and logs a recoverable server error.
- Update log corruption: provider falls back to latest valid snapshot if available and marks document for operator review.
- Message too large: provider rejects the update and asks client to resync from snapshot.

## Testing And Acceptance Criteria

### Collaboration

- Two browser clients can edit the same Markdown document and converge.
- MarkLab.app and browser can edit the same Markdown document and converge.
- A guest can edit while the original host app is offline.
- Host app reconnects and receives guest changes.
- Concurrent edits converge without manual merge when they are normal Yjs-compatible text edits.

### Cursor And Highlight

- Browser-to-browser cursor and selection are visible.
- App-to-browser cursor and selection are visible.
- Browser-to-app cursor and selection are visible.
- Selection remains correctly anchored after another user inserts text before it.
- Cursor disappears after disconnect.

### Local File Projection

- Local file opens into Y.Text without content loss.
- Remote edits project back to local Markdown.
- AI/local direct disk edits are ingested into Y.Text when safe.
- Divergent local disk and shared edits trigger conflict diff.
- Missing local file pauses projection and does not silently recreate a file.

### Permission And Control Plane

- View link cannot write.
- Edit link can write.
- Revoked link disconnects active sessions.
- Provider token expires and refreshes without losing document state.
- Share key can add a member to a relay/workspace.
- Seat limit can block additional members or sessions according to plan.

### Server Durability

- Provider restart does not lose document state.
- Client can reconnect after provider restart.
- Snapshot compaction preserves content.
- Awareness is not persisted as document history.

## Phase Plan

### Phase 0: Relay Study And Architecture Alignment

Completed by this design:

- Adopt Relay-like collaboration primitives.
- Adopt Relay-like server/control-plane separation.
- Keep MarkLab v1 single-file.
- Use Relay-like conflict UX for the first version.
- Include cursor/highlight as a v1 requirement.
- Include control-plane foundation in MVP architecture.

### Phase 1: Single-File Yjs Provider MVP

Build the collaboration provider foundation:

- Yjs sync websocket.
- Durable update log and snapshot.
- Short-lived provider token validation.
- Document-level view/edit grants.
- Browser IndexedDB persistence.
- App local Yjs persistence.
- Awareness fanout.
- Remote cursor/highlight.

### Phase 2: MarkLab.app Integration

Build the native app collaboration surface:

- MarkEdit-based CodeMirror editor.
- CodeMirror to Y.Text binding.
- Remote cursor/selection decorations.
- Local Markdown projection.
- File watcher ingestion.
- Share/manage controls.
- Relay-like conflict diff.

### Phase 3: Control Plane MVP

Add the product/business foundation:

- Users.
- Relays/workspaces.
- Members.
- Owner/Member/Reader roles.
- Share keys.
- Seat limits.
- Plan and subscription records.
- Minimal login/account UI.
- Minimal member/share management UI.

### Phase 4: Team And Commercial Surface

Expand beyond the technical MVP:

- Billing integration.
- Plan upgrade/downgrade.
- Subscription management UI.
- Private resource UI.
- Folder permission UI.
- Advanced team admin.
- SSO later.

### Phase 5: Folder And Attachment Expansion

Only after single-file collaboration is stable:

- Folder collaboration design.
- File tree metadata.
- Rename/delete handling.
- Attachment storage.
- Quotas.
- Self-hosted provider packaging.

## Key Decisions

1. MarkLab v1 remains single-file collaboration.
2. Browser and MarkLab.app are both official collaborator entry points.
3. Host-gated proposals are not the target architecture for offline guest editing.
4. MarkLab should move to Relay-like Yjs provider sync.
5. MarkLab should use Relay-like server/control-plane separation.
6. MVP architecture includes account/member/role/share-key/seat/subscription foundations.
7. Full commercial/team UI is phased after the collaboration engine.
8. Conflict UX starts Relay-like and simple.
9. Cursor/highlight is a v1 requirement.
10. AI edits local files; CLI controls MarkLab software actions.

## Spec Self-Review

- No unresolved placeholders remain.
- The design keeps v1 single-file while preserving a path to team and folder features.
- The server architecture aligns with Relay's proven split but avoids dependence on Relay's proprietary control plane.
- The conflict UX is intentionally simplified to Relay-like behavior.
- The control-plane model is included in MVP architecture without forcing full billing/team UI into the first technical slice.
