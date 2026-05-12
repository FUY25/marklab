# MarkLab Relay-Like Collaboration Design

Date: 2026-05-11

Status: Design approved in brainstorming. This document is the product and architecture specification for the next MarkLab collaboration direction.

External source references are tracked in [learning-resources.md](learning-resources.md). Those repositories are local-only learning clones, not vendored MarkLab source.

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
7. Support AI/local-agent workflows through local file edits and CLI-controlled software actions. AI agents and local tools may edit any local Markdown file at any time; only files that are part of an active collaboration room reconcile with shared Y.Text state.
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
8. Do not make rich/WYSIWYG editing the canonical MVP editor before source-offset mapping, remote cursor rendering, and Y.Text synchronization are proven.

## Locked Decisions From Grill

These decisions supersede older exploratory MarkLab notes if there is a conflict.

1. V1 collaboration scope is one Markdown file per collaboration room.
2. MarkLab.app and browser are both formal collaborator entry points. Browser access is not only a preview or temporary fallback.
3. Public MVP is login-backed. Anonymous access is allowed only for internal development and smoke testing, while public guest participation must go through control-plane guest sessions.
4. Guest edit links are allowed so people without MarkLab.app can participate. Guest edit must be represented as a session with identity, role, quota/seat impact, and revocation.
5. The provider direction is Y-Sweet / Relay-style provider first, not Hocuspocus-first.
6. The implementation basis should start from upstream `jamsocket/y-sweet`, while Relay's Y-Sweet usage, server template, token flow, and deployment shape are architecture references.
7. MarkLab implements its own control plane. It must not depend on Relay's proprietary account, permission, billing, or subscription implementation.
8. Control plane and collaboration provider are independent logical services from the start. They may be deployed in one Fly app for the first phase, but the boundary should be real in the code.
9. The local `.md` file is always the user-owned artifact. `Y.Text("contents")` is the live-merge surface used while edit-capable clients are connected. On watcher events and reconnect, MarkLab compares three values: `lastProjectedMarkdown`, current disk Markdown, and current provider Markdown. If only one side changed, MarkLab applies that side. If both disk and provider changed from the same baseline, MarkLab opens conflict UI unless a future true three-way merge can prove the merge is safe. Local disk must not silently overwrite remote edits.
10. Local projection uses Relay-derived behavior: 2-second debounced auto-write, manual save flush, stored `lastProjectedMarkdown`, `lastProjectedHash`, and provider state fingerprint bookkeeping, transaction-origin tagging to suppress self-loopback through the file watcher, and a Relay-like conflict diff when reconciliation cannot proceed automatically.
11. V1 view links are current-state rendered views, not Yjs provider participants. A viewer receives the full current Markdown/rendered document through the control plane, cannot write, does not mount a source editor, does not publish presence, and does not store Yjs update history in IndexedDB. A later "trusted live read-only collaborator" mode may connect to Y-Sweet with `authorization: "read-only"`, but that is not the public view-link MVP.
12. Provider document ids are opaque server-generated ids. File path, filename, workspace name, and user identity must not be encoded into provider document ids.
13. MVP editing uses CodeMirror 6 source editing plus live preview. Rich/WYSIWYG editing is delayed until the adapter risks are proven.
14. `apps/collab-web` should be a new independent browser collaboration app based on Vite, React, and TypeScript. It should not start by rewriting the existing `apps/web`.
15. CollabMD is a browser UI/editor-shell reference only. MarkLab should not adopt CollabMD's sync/server model.
16. Vditor is a Phase 2 rich-mode candidate because it is Markdown-string centered, but it must not become the default collaborative editor before offset mapping and remote cursor/highlight support are verified.
17. Conflict UX starts Relay-like and simple. The older complex MarkLab three-way/base/local/shared/AI merge UI is deferred.
18. AI edits should operate through the local Markdown file when a local file exists. CLI commands should control software actions such as share, revoke, export, status, wait-for-sync, and conflict inspection.

## Product Scope

### Technical MVP

The technical MVP proves the collaboration engine and local-file workflow:

- One Markdown file per collaboration room.
- MarkLab.app native editor based on MarkEdit/CodeMirror.
- Browser editor as a formal collaborator entry point.
- MVP browser editing starts with CodeMirror source editing plus live preview.
- New `apps/collab-web` browser collaboration app, separate from the existing `apps/web` shell.
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
- Workspace object (contains many single-file documents; alias `relay` for compatibility with Relay-derived terminology).
- Workspace members.
- Roles: `Owner`, `Member`, `Reader`.
- Workspace share keys / invite keys.
- Document-level access grants: `view` and `edit`.
- Sessions: browser, app, daemon, agent, and guest.
- Provider tokens: short-lived tokens used to connect to the Yjs collaboration provider.
- Plans, workspace member-seat limits, and concurrent-guest-edit quota.
- Subscription records.

Billing, plan upgrade UI, SSO, enterprise admin, folder-private UI, and attachment billing may ship later, but the schema and architecture must leave room for them. The MVP schema should already understand logged-in users, server/relay membership, folder permissions for later expansion, private folders for later expansion, share keys, subscriptions, seat limits, billing/control-plane concepts, and guest sessions.

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

### Provider Source Decision

MarkLab should not copy the current alpha's host-gated relay protocol into the next architecture. The provider target is a Y-Sweet / Relay-style sync provider.

Implementation guidance:

- Start from upstream `jamsocket/y-sweet` as the main provider implementation basis.
- Study Relay's Y-Sweet integration, server template, deployment setup, token expectations, and client connection shape.
- Keep MarkLab's control plane separate from the provider. The provider validates short-lived document-scoped tokens; it does not own the product account model.
- Keep `Y.Text("contents")` as the shared Markdown text type.
- Persist updates and snapshots durably so host-offline editing works.

### Relay And Y-Sweet Material Checked

The design choices above were checked against the local Relay and Y-Sweet learning clones:

- Relay stores Markdown in `ydoc.getText("contents")`.
- Relay saves local projection with a 2-second debounce.
- Relay keeps a disk buffer and uses `diff-match-patch` to turn local text changes into Y.Text updates.
- Relay has a `pendingOps` queue, but it only protects in-memory editor operations while the plugin is active. It does not replace MarkLab's required `lastProjectedMarkdown` baseline because MarkLab must handle offline disk edits made while MarkLab.app is closed.
- Relay uses `Y.PermanentUserData` for stable UI identity mapping, but MarkLab must treat provider/control-plane session metadata as authoritative for audit.
- Y-Sweet supports `authorization: "full" | "read-only"` and `validForSeconds` on token requests.
- Y-Sweet upstream tests prove read-only tokens reject raw HTTP and websocket writes. MarkLab should keep equivalent malicious-client tests before shipping any trusted live read-only provider mode.
- Y-Sweet native provider tokens are not JWTs. MarkLab's Y-Sweet-first path should request Y-Sweet `ClientToken`s through the control plane and store MarkLab grant/session metadata separately.

## Architecture

```text
MarkLab.app
  MarkEdit-based CodeMirror editor
  local Y.Doc / Y.Text
  local file projection
  local persistence
  share/manage UI

Browser editor
  apps/collab-web
  Vite + React + TypeScript
  CodeMirror 6 Markdown editor
  source editor + live preview / split view
  Y.Doc / Y.Text
  IndexedDB persistence for edit sessions
  view/edit link join
  presence avatars
  remote cursor and selection highlight
  connection status

MarkLab Control Plane
  users
  workspaces (each contains many single-file documents)
  workspace members
  roles
  workspace share keys
  per-document access grants (view / edit)
  sessions (human / agent / guest)
  plans
  workspace seat limits + concurrent-guest-edit quota
  subscription records
  Y-Sweet ClientToken minting (10-min TTL, refresh-denial revocation)

MarkLab Collaboration Provider
  Yjs sync websocket
  document-scoped token validation
  update log
  periodic snapshots
  awareness fanout
  reconnect support

Storage
  Postgres for metadata
  Fly volume at /data/ysweet for alpha Y-Sweet checkpoints
  S3/object storage later for provider snapshots if the provider is split or scaled
  object storage later for attachments
```

The first deploy is one Fly app plus Neon Postgres, with the API supervising an upstream Y-Sweet 0.9.1 child process on `127.0.0.1:8080`. Provider state is stored on a Fly volume at `/data/ysweet`; local development uses `.marklab-provider-data/ysweet`. Internally, the code is still organized around the control-plane/provider/storage split so it can later scale or be self-hosted like Relay.

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
- Control plane and provider are separate logical deployments even if the first phase co-locates them in one Fly machine.

The host no longer approves every edit. The host is one client with a local Markdown projection and owner/admin controls.

### Deployment Phases

Phase 1 can use existing infrastructure:

- One Fly app.
- Neon Postgres.
- Web, control-plane API, and API-supervised upstream Y-Sweet child process in one Fly machine.
- Separate internal modules for web, control plane, provider, and persistence.
- Single machine only, with sticky routing not required if there is only one machine.
- Root-mounted public provider routes in process mode: `/d/<providerDocId>/ws/<providerDocId>`, `/d/<providerDocId>/as-update`, and `/d/<providerDocId>/update` are proxied by the API to the child provider. `MARKLAB_YSWEET_PUBLIC_URL_PREFIX` must be HTTPS and must not include a path in this mode.

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
- `workspaces` (alias `relays`): top-level container that owns members, share keys, seats, and many single-file rooms. A workspace is not the same thing as a document. v1 UI may render this as "your shared documents" without surfacing workspace chrome, but the schema is workspace-scoped from day one so seats/billing/folders can layer on later without migration.
- `workspace_members`: users inside a workspace.
- `roles`: `Owner`, `Member`, `Reader`.
- `share_keys`: invite keys for joining a workspace.
- `documents`: one Markdown document resource, with an opaque provider document id. A workspace contains many documents. v1 limits each document to a single Markdown file; folder/multi-file collaboration is Phase 5.
- `document_access_grants`: per-document view/edit links.
- `sessions`: browser/app/daemon/agent/guest participant sessions.
- `plans`: free/dev/team/business plan definitions.
- `seat_limits`: workspace-scoped maximums (named-member seats and a separate concurrent-guest-edit quota; see Permission Model).
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
- Last projected Markdown content and hash.
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

- `view`: full-document current-state rendered read access; no provider write/read token by default in v1.
- `edit`: collaborative editing access.

Public MVP access rules:

- Logged-in users are the normal public product identity.
- Anonymous access is allowed only for internal development and smoke testing.
- Guest collaborators without MarkLab.app can join through edit/view links, but the control plane must still create a guest session.
- Guests do not count against workspace member seats. Each workspace has a separate "concurrent guest sessions" quota (e.g. free plan = 3 concurrent guest sessions per workspace; paid plans increase the cap). The control plane enforces this at token-mint time.
- Revoking an edit link or grant must invalidate the next provider-token refresh. The provider does not have an active revocation channel in v1; effective revocation lag is bounded by the token TTL (see below). Revoking a view link takes effect on the next control-plane document fetch because view links do not keep provider websocket credentials.

Provider tokens must be short-lived and document-scoped. A permanent share link must not directly be the provider write credential. The flow should be:

1. User or guest opens a share link.
2. Control plane validates link, membership, expiry, revocation, seat rules, and role.
3. Control plane creates or updates a session.
4. Control plane issues a short-lived provider token.
5. Client connects to the collaboration provider with that token.
6. Client refreshes the token before expiry against the control plane; control plane may deny the refresh (revocation enforcement point).

This follows Relay's token pattern and avoids making long-lived share URLs equivalent to raw websocket write credentials.

Token TTL policy (v1):

- Provider token TTL: 10 minutes.
- Refresh margin: 2 minutes before expiry.
- Client-side refresh check interval: 30 seconds.
- Revocation enforcement: refresh denial only. Worst-case revocation lag ≈ TTL.
- Active provider-side cutoff (denylist or revocation pub-sub) is explicitly deferred to a later phase. The MVP accepts the 10-minute TTL-bounded lag in exchange for stateless provider verification.

Provider tokens use Y-Sweet native document tokens in the Y-Sweet-first implementation:

```ts
type MarkLabProviderTokenRequest = {
  documentId: string;
  providerDocId: string;
  sessionId: string;
  authorization: "full" | "read-only";
  validForSeconds: number;
};
```

The MarkLab control plane stores the grant/session/workspace metadata and asks Y-Sweet's `DocumentManager` for a `ClientToken` with `authorization` and `validForSeconds`. The provider validates Y-Sweet's native token signature, document id, expiration, and authorization. If MarkLab later ships trusted live read-only collaborators, their provider tokens must map to Y-Sweet's `authorization: "read-only"` and must be tested with a malicious raw Yjs write attempt. Revocation in v1 relies on the short TTL plus refresh denial described above; a later phase may add an active revoke channel for high-risk cases.

If MarkLab later replaces Y-Sweet with a custom provider, that provider may use JWT claims carrying `docId`, `providerDocId`, `sessionId`, `role`, `exp`, and `jti`. That is not the Y-Sweet-first MVP path.

Provider runtime auth is split into two generated Y-Sweet values. `MARKLAB_YSWEET_AUTH` is the private key passed to the child provider as `Y_SWEET_AUTH`, not on the process command line. `MARKLAB_YSWEET_SERVER_TOKEN` is used by MarkLab's `DocumentManager` connection string and `/check_store` health probe.

## Canonical State And Projection

MarkLab has one user-owned artifact and one live-merge surface. They are not two "sources of truth" in tension; they are the same content viewed at two layers and reconciled through a stored baseline.

- User-owned artifact: the local `.md` file on disk. Always owned by the user. Always editable by any local tool (vim, VS Code, Cursor, an AI agent). MarkLab never silently overwrites this file.
- Live-merge surface: `Y.Text("contents")` inside the provider Y.Doc. Used while clients are connected so that concurrent edits across MarkLab.app, browser, and other connected sessions converge cleanly. Browser/app guests collaborate against this surface while the host is offline.

When clients are connected, edits flow through Y.Text and project to disk. When clients are disconnected (network down, app closed, share toggled off, last collaborator left for a week), the local `.md` keeps being edited normally — by the user, by AI, by anything. On (re)connect, MarkLab reconciles the local file into Y.Text rather than treating Y.Text as authoritative-over-disk.

The required baseline tuple is:

```ts
type LocalProjectionBaseline = {
  lastProjectedMarkdown: string;
  lastProjectedHash: string;
  lastProviderStateFingerprint: string;
  updatedAt: string;
};
```

This baseline is updated only after MarkLab successfully projects provider state to disk or successfully ingests disk state into provider state.

### Projection (Y.Text → disk)

- Auto-project shared Y.Text to disk with a 2-second debounce.
- Manual save (`Cmd+S` / `Ctrl+S`) flushes immediately.
- The app tracks `lastProjectedMarkdown`, `lastProjectedHash`, and the provider state fingerprint so it can distinguish its own writes from external writes and detect both-sides-changed cases.
- All projection writes go through MarkLab's writer, never through arbitrary remote-client code paths. Browser-only guests never write to the owner's local disk.

### Ingestion (disk → Y.Text)

When the file watcher fires on a shared file:

1. Read the new disk contents and normalize line endings to LF (`\r\n` → `\n`). LF is the only line-ending stored in Y.Text; CRLF is reconstructed at the disk boundary if the OS requires it.
2. If the new disk hash equals the last projected disk hash, this is a self-loopback from MarkLab's own writer — drop the event.
3. Compute `providerChanged = currentYTextMarkdown !== lastProjectedMarkdown` and `diskChanged = newDiskMarkdown !== lastProjectedMarkdown`.
4. If `diskChanged` is false, drop the event.
5. If `providerChanged` is false, run `diff-match-patch` between `lastProjectedMarkdown` and the new disk content, with `diff_cleanupSemantic`, and apply the resulting insert/delete operations to Y.Text inside a single `ydoc.transact(fn, origin)` call.
6. If `providerChanged` and `diskChanged` are both true, open conflict UI before applying either side. The MVP must not silently transform current provider contents into the disk contents.
7. Tag any successful transaction with a MarkLab-owned `origin` symbol so editor bindings observing Y.Text can distinguish disk-ingest from user-keystroke origins and skip echo behavior.

### Concurrent-edit reconciliation (the `pendingOps` queue)

If a remote edit lands while a disk diff is in flight (or vice versa), MarkLab can additionally use the Relay `pendingOps` pattern for in-memory editor operations:

- In-flight editor functions that have not yet been applied to Y.Text are kept in a queue.
- When reconciling disk → Y.Text, MarkLab replays each pending op against the post-diff text.
- If the replayed result still matches the on-disk content, the diff applies cleanly and the queue is cleared.
- If the replayed result diverges, the diff is considered stale and MarkLab surfaces the conflict UI (see Conflict UX) instead of guessing.

This queue is not a substitute for the stored baseline. It helps with in-flight editor operations, while `lastProjectedMarkdown` detects arbitrary offline disk edits made while MarkLab was closed.

### (Re)connect reconciliation

When a client transitions from disconnected to connected, or when a previously-idle document re-enters live collaboration:

1. Download the latest provider snapshot and apply it to the local Y.Doc.
2. Read the current on-disk content and load `lastProjectedMarkdown`.
3. If disk equals baseline and provider changed, project provider contents to disk.
4. If provider equals baseline and disk changed, ingest disk contents into Y.Text.
5. If both disk and provider diverged from baseline, surface the conflict UI before any disk write or any further provider sync writes for this document.
6. If a future true three-way merge is added, it must write a version/snapshot and still fall back to conflict UI when the merge is not mechanically safe.

### CLI surface for safe coordination

CLI and agent commands expose `status`, `wait-for-sync`, and conflict state so local automation can coordinate safely around an in-flight session. Routing details — which CLI subcommands talk to the local MarkLab.app over IPC vs the control plane over HTTPS — are deferred to the CLI implementation ticket; the contract is that `wait-for-sync` blocks until the local Y.Doc has fully synced and projected to disk.

## Collaboration Data Flow

### Create And Share

1. User opens a local Markdown file in MarkLab.app.
2. MarkLab creates a local Y.Doc and imports the Markdown into Y.Text.
3. MarkLab creates a control-plane document resource.
4. MarkLab creates or selects a workspace context to own the document.
5. MarkLab uploads initial Yjs state or initial update set to the collaboration provider.
6. User creates view/edit share links or share keys.
7. Control plane stores grants and returns safe URLs.

### Browser Join

1. Browser opens a share URL.
2. Control plane validates link and creates a session.
3. For an edit grant, browser receives a short-lived provider token, creates a Y.Doc, connects to the provider, and stores local Yjs persistence in IndexedDB for offline/reconnect.
4. For a view grant, browser receives only the current rendered document / current Markdown snapshot from the control plane, not a provider token.
5. Browser shows editor or read-only rendered view according to role.

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

This is the long-tail case: the host (or any participant) was disconnected for an extended period — minutes, hours, or weeks — while local edits and/or remote edits accumulated.

1. Client reconnects and fetches the latest provider snapshot into the local Y.Doc.
2. Client reads disk and compares disk/provider against `lastProjectedMarkdown`.
3. If only provider changed, projection writes provider contents to disk and remote clients remain unchanged.
4. If only disk changed, ingestion applies disk changes to Y.Text and remote clients receive the merged update.
5. If both changed, app surfaces the Relay-like conflict diff (see "Conflict UX") before any further projection or sync writes for that document.
6. User chooses keep editor/shared contents or accept local disk; the chosen resolution is applied as a single origin-tagged Y.Text transaction.

## Local File And AI Workflow

The local Markdown file remains a first-class product object.

AI agents and local tools may edit any local `.md` file at any time. They do not need to know whether a file is currently shared. For files that are not part of an active collaboration room, the edit is just a regular disk write — nothing else happens. For files that *are* part of an active room, the file watcher picks the change up and runs the ingestion path defined in "Canonical State And Projection" (LF normalize → self-loopback check via projected-hash → compare disk/provider against `lastProjectedMarkdown` → apply one-sided changes or open conflict for both-sides-changed cases). The CLI controls software actions such as share, revoke, export, status, wait-for-sync, and conflict inspection. AI should not write through a hosted content mutation API.

This means multi-file AI workflows (Cursor / Aider / Claude Code editing across a docs/ folder) are supported in v1 even though collaboration itself is per-file: the AI just edits the files. Shared files reconcile; unshared files are local writes. No special "AI-aware" handling is required in v1.

When the local file changes:

1. File watcher detects disk change.
2. MarkLab runs the ingestion path (see "Canonical State And Projection").
3. If reconciliation applies cleanly, the change propagates to other connected clients via Y.Text.
4. If reconciliation cannot apply, MarkLab opens the conflict diff.
5. After resolution, MarkLab projects the chosen content back to disk and provider state.

An explicit agent edit protocol can be added later:

- `marklab agent edit begin`
- `marklab agent edit end`
- `marklab status`
- `marklab wait-for-sync`
- `marklab conflict`

V1 relies on file-watcher ingestion only. The explicit `begin/end` protocol is reserved for cases where rapid AI-driven full-file rewrites (an agent that produces complete new file content rather than surgical patches) produce noisy conflict behavior with concurrent remote edits. Until that protocol ships, unattended AI rewrites of a shared file during active multi-client collaboration may legitimately surface conflict UI; this is acceptable v1 behavior.

## Editor Choice

MarkLab.app should use CodeMirror + Y.Text because MarkEdit is already CodeMirror-oriented and Relay's native collaboration path is CodeMirror-oriented.

The browser MVP should also use CodeMirror + Y.Text. Keeping browser editing on the same source-text model as MarkLab.app reduces adapter risk for:

- Markdown serialization.
- Cursor and selection mapping.
- Yjs text binding.
- Conflict diff.
- AI/local file patches.

The shared collaborative document remains:

```ts
ydoc.getText("contents")
```

That Y.Text is the canonical collaboration state. Editor surfaces may render or transform Markdown for display, but they must not replace the canonical text model.

### Browser Collaboration App

The MVP browser collaboration surface should be a new `apps/collab-web` app rather than a rewrite of the current `apps/web`.

Recommended stack:

- Vite.
- React.
- TypeScript.
- CodeMirror 6 Markdown editor.
- Yjs binding to `Y.Text("contents")`.
- Live preview and split-view option.

Required MVP UI:

- Source editor for edit links.
- Live preview / split view.
- Presence avatars.
- Remote cursor.
- Remote selection highlight.
- Connection status.
- Share/view/edit mode chrome.
- Rendered read-only view for view links, with selectable/copyable document content and no editor mount.

Out of MVP:

- File tree.
- Folder workspace.
- Comments.
- Chat.
- Follow mode.
- Diagrams.
- Wiki-links/backlinks.
- CollabMD server/sync/persistence/auth.

CollabMD can be used as front-end design and editor-shell reference, especially for dense Markdown collaboration UI. Its sync and server architecture should not be adopted.

### Rich Mode Candidate: Vditor

Vditor is a strong Phase 2 candidate for online/browser rich Markdown editing because it is Markdown-string centered and supports multiple Markdown editing modes:

- `wysiwyg`: rich WYSIWYG editing.
- `ir`: instant-rendering Markdown editing.
- `sv`: source/split-view editing.

This makes Vditor more compatible with MarkLab's Relay-like `Y.Text("contents")` model than editor frameworks that treat a proprietary rich document tree as the primary state.

Vditor should be treated as an editor surface candidate, not as the collaboration architecture. Sync, permissions, awareness, provider tokens, persistence, and conflict behavior still belong to MarkLab's Y-Sweet/Relay-style provider and MarkLab control plane.

Before adopting Vditor as an editable rich mode, MarkLab must prove an adapter with these acceptance tests:

- Local Vditor input can be diffed into minimal Y.Text updates.
- Remote Y.Text updates can update Vditor without echo loops, cursor jumps, scroll jumps, or undo-stack corruption.
- Local Vditor selection can be mapped to Markdown source offsets.
- Remote Yjs relative positions can be mapped back into Vditor cursor and selection decorations.
- The mapping works for bold, links, inline code, fenced code blocks, lists, tables, frontmatter, and CJK text.
- One collaborator can use CodeMirror source mode while another uses Vditor rich mode, with content, cursor, and highlight state remaining correct.

Until that adapter passes, Vditor is a Phase 2 rich-mode candidate only. It must not replace the MVP CodeMirror source editor.

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
  kind, // "human" | "agent" — distinguishes AI sessions from people
});

awareness.setLocalStateField("cursor", {
  anchor: Y.createRelativePositionFromTypeIndex(ytext, selection.anchor),
  head: Y.createRelativePositionFromTypeIndex(ytext, selection.head),
});
```

The important implementation detail is Yjs relative positions. MarkLab should not use raw absolute offsets for cross-client cursor state because offsets drift under concurrent edits.

Stable UI identity binding: MarkLab uses `Y.PermanentUserData` (as Relay does) to bind each `ydoc.clientID` to a stable display identity at session start:

```ts
const permanentUserData = new Y.PermanentUserData(ydoc);
permanentUserData.setUserMapping(ydoc, ydoc.clientID, sessionIdentity);
```

`sessionIdentity` encodes the display identity for that session — a user id for logged-in humans, a guest session id for link guests, an agent session id for CLI/AI clients. This survives disconnect/reconnect well enough for cursor labels, conflict-diff labels, and future "who is editing" UI. It also makes the human-vs-agent distinction durable for UI purposes rather than awareness-only.

Remote cursor and selection rendering applies in the source editor pane. In preview-only or pure-rendered-view modes (browser split view set to "preview" or future HTML-snapshot view), MarkLab shows a non-positional presence indicator (e.g. "Alice is editing") instead of a caret. Cursor/highlight rendering is required wherever a source editor pane is visible.

View-link readers do not publish awareness and do not appear as collaborators in v1. Presence and cursor/highlight are for edit-capable sessions and trusted app/browser collaborators with a provider connection.

`Y.PermanentUserData` is UI attribution metadata, not the authoritative audit log. Version/audit attribution must come from the control-plane session id and provider-token session metadata recorded server-side. A malicious client must not be able to create authoritative authorship merely by writing a different `PermanentUserData` mapping.

## Conflict UX

The first conflict UX should be Relay-like and intentionally simple.

Conflict is surfaced when reconciliation (see "Canonical State And Projection") cannot apply automatically — typically because both the local disk content and the shared Y.Text content diverged from `lastProjectedMarkdown`, or because a `pendingOps` replay for in-flight editor work no longer matches on-disk content.

Conflict state shown to the user:

- Editor/shared Y.Text contents.
- Local disk contents.
- `lastProjectedMarkdown` and `lastProjectedHash` for comparison.

User choices:

- Keep editor (Y.Text) contents — overwrites local disk with current shared state.
- Accept local disk contents — replaces shared Y.Text via a single diff-match-patch transaction tagged with a conflict-resolution origin, so other clients see one clean update.
- Later: hunk-level accept.
- Later: AI-assisted merge.

The old MarkLab three-way conflict UI with base/local/shared/AI merge is deferred. It remains a possible future upgrade, but it should not block the collaboration MVP.

Conflict principles:

- Never silently overwrite local disk changes.
- Never silently discard provider/editor changes.
- Show the diff before asking for a decision.
- Apply the chosen resolution to both local projection and shared Yjs state.
- While a conflict is unresolved for a document, MarkLab pauses both projection writes and disk ingestion for that document. Other documents are unaffected.
- Record a version/snapshot when resolving if versioning is available.

## Error Handling

### Auth And Permission Errors

- Expired provider token: client requests a fresh token from control plane.
- Revoked edit link: the next provider-token refresh fails and the client becomes unavailable within the token TTL. Active provider-side disconnect is not in v1.
- Revoked view link: the next control-plane document fetch fails immediately after revocation.
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

- View link cannot write because public view links do not receive provider credentials in v1.
- Public view link does not receive a provider token, does not mount the editor, does not publish presence, and does not persist Yjs updates in IndexedDB.
- A trusted live read-only provider token, if added later, rejects a raw malicious Yjs update over HTTP and websocket.
- Edit link can write.
- Revoked edit link causes the next provider-token refresh to fail; active edit sessions disconnect within at most one provider-token TTL (10 minutes) of revocation.
- Provider token expires and refreshes without losing document state.
- Share key can add a member to a workspace.
- Workspace member-seat limit blocks additional members according to plan.
- Concurrent-guest-edit quota blocks new guest sessions when exhausted; existing guest sessions remain unaffected.

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

Build the collaboration provider foundation. Phase 1 owns the server side end-to-end; the rich browser UI is Phase 1B. Phase 1 ships with a minimal harness client (likely a CLI- or test-only browser shell) sufficient to validate the acceptance criteria below.

- Yjs sync websocket.
- Durable update log and snapshot.
- Short-lived Y-Sweet ClientToken validation (10-min `validForSeconds`, 2-min refresh margin, provider-side token signature/expiration/document/authorization enforcement).
- Document-level view/edit grants.
- Join flow: stub auth (dev-mode token-mint endpoint) is acceptable for Phase 1 harness work only. Real login/control-plane session handling must land before public browser/native client work. Phase 1's token/session API contract must already match the post-control-plane shape so the auth swap is internal.
- Guest sessions (control-plane creates a guest session record even under stub auth).
- App local Yjs persistence (used by the Phase 1 harness; full app integration is Phase 2).
- Awareness fanout.
- `Y.PermanentUserData` clientID-to-identity binding.
- Opaque provider document ids.
- Revocation: refresh denial only; provider has no active cutoff in Phase 1.
- Malicious-client negative test proves read-only Y-Sweet authorization rejects raw HTTP/websocket updates before any trusted live read-only mode can ship.
- Phase 1 and any pre-control-plane browser harness work are internal technical slices. They are not public MVP release candidates until real login/control-plane UI replaces stub auth.

Phase 1 acceptance criteria that require a browser UI (browser IndexedDB persistence, remote cursor/highlight rendering, presence avatars) move to Phase 1B; Phase 1 validates the server-side awareness fanout and Y.Doc persistence with the harness client.

GStack plan-review refinement: execute the Control Plane MVP immediately after provider runtime and before production-facing browser/native client work. Otherwise browser/native clients will bake in a dev-only session model and then need to be rewritten for real users, guests, grants, token refresh, and revocation. The phase labels below describe product capability groups; the implementation roadmap in `docs/plans/2026-05-11-marklab-alpha-plan-roadmap.md` defines the execution order.

### Phase 1B: Browser Collaboration App MVP

Build the first formal browser collaborator entry point. Phase 1B includes the browser-side acceptance criteria deferred from Phase 1, but production-facing browser work should start after the Control Plane MVP has locked the real session/grant/token-refresh contract.

- New `apps/collab-web` Vite + React + TypeScript app.
- CodeMirror 6 Markdown source editor.
- Live preview / split view.
- Y.Text binding to the provider document.
- Browser IndexedDB persistence (y-indexeddb).
- Presence avatars.
- Remote cursor and remote selection highlight (rendered in source pane; non-positional presence indicator in preview-only mode).
- View/edit mode handling.
- Public view mode fetches current rendered document state through the control plane rather than connecting to the provider.
- Connection/offline/reconnecting states.

### Phase 2: MarkLab.app Integration

Build the native app collaboration surface:

- MarkEdit-based CodeMirror editor.
- CodeMirror to Y.Text binding.
- Remote cursor/selection decorations.
- Local Markdown projection.
- Approximately 2 second debounced auto-projection.
- Manual save flush.
- File watcher ingestion.
- Share/manage controls.
- Relay-like conflict diff.

Optional Phase 2 rich-mode spike:

- Evaluate Vditor as the browser rich Markdown editor surface.
- Keep Y.Text("contents") as the canonical state.
- Do not promote Vditor to default collaborative editing until source-offset mapping and remote cursor/highlight rendering are verified.

### Phase 3: Control Plane MVP

Add the product/business foundation. In execution order, this runs before production-facing browser/native client implementation:

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

1. MarkLab v1 collaboration is per-document single-file; a workspace contains many such documents and owns members, share keys, and seats.
2. Browser and MarkLab.app are both official collaborator entry points.
3. Host-gated proposals are not the target architecture for offline guest editing.
4. MarkLab should move to Y-Sweet / Relay-like Yjs provider sync.
5. Upstream `jamsocket/y-sweet` is the main provider implementation basis; Relay is the architecture/deployment reference.
6. MarkLab should use Relay-like server/control-plane separation.
7. Public MVP is login-backed, with guest sessions for link-based guest participation. Guests do not consume workspace member seats; each workspace has a separate concurrent-guest-edit quota.
8. MVP architecture includes account/member/role/share-key/seat/subscription foundations.
9. Provider document ids are opaque server-generated ids.
10. The local `.md` file is always the user-owned artifact. `Y.Text("contents")` is the live-merge surface used while edit-capable clients are connected. Reconciliation between disk and Y.Text on watcher events and reconnect compares `lastProjectedMarkdown`, disk markdown, and provider markdown; both-sides-changed cases open conflict UI instead of silently preferring disk or provider. `pendingOps` is only an additional in-memory safety mechanism, not the offline baseline.
11. Full commercial/team UI is phased after the collaboration engine.
12. Conflict UX starts Relay-like and simple. Conflict pauses projection and ingestion for the affected document only.
13. Cursor/highlight is a v1 requirement; rendered in source panes, with non-positional presence indicators in preview-only views. `Y.PermanentUserData` is UI attribution metadata only; authoritative audit attribution comes from control-plane session/provider-token metadata.
14. AI edits local files freely (shared or unshared); only shared files reconcile with Y.Text. CLI controls MarkLab software actions.
15. MVP editing uses CodeMirror source editing plus live preview; Vditor is a Phase 2 rich-mode candidate, not the MVP canonical editor.
16. `apps/collab-web` should be a new Vite + React + TypeScript browser app.
17. CollabMD is a front-end UI/editor-shell reference only, not a sync/backend source.
18. Provider tokens are Y-Sweet ClientTokens with 10-minute `validForSeconds`, 2-minute refresh margin, and 30-second client refresh check; revocation is refresh-denial only in v1. The provider has no active denylist or revoke channel in v1.
19. V1 view links are current-state rendered read access through the control plane, not Yjs provider participants. Trusted live read-only collaboration is a later mode and must use Y-Sweet read-only authorization with malicious-write tests.
20. Y.Text stores LF-only content. CRLF normalization happens at the disk boundary on read/write.
21. Plan 1B pins the alpha provider runtime to an API-supervised upstream Y-Sweet 0.9.1 child process. `/healthz` must prove database, required provider schema tables/columns, relay readiness, provider `/ready`, and authenticated provider `/check_store` before production traffic is accepted.

## Spec Self-Review

- No unresolved placeholders remain.
- The design keeps v1 single-file while preserving a path to team and folder features through a workspace-scoped schema.
- The server architecture aligns with Relay's proven split but avoids dependence on Relay's proprietary control plane.
- The canonical-state model has one user-owned artifact (`.md` on disk) and one live-merge surface (`Y.Text`); reconciliation is baseline-aware and does not allow stale disk to silently overwrite provider edits.
- Revocation lag is bounded by token TTL (10 min) and explicitly accepted as v1 edit-link behavior; active provider-side cutoff is a later-phase feature.
- The public view-link model avoids Yjs update-log leakage by rendering current state through the control plane without provider tokens or IndexedDB Yjs persistence.
- AI workflows are honest about v1 scope: multi-file editing works because the AI edits local files; only shared files reconcile.
- The conflict UX is intentionally simplified to Relay-like behavior.
- The control-plane model is included in MVP architecture without forcing full billing/team UI into the first technical slice.
- Vditor is captured as a future rich Markdown surface without changing the MVP Y.Text architecture.
- The grill decisions are recorded as explicit product and architecture constraints rather than implied conversation context.

### Known residual risks (acceptable for implementation planning)

- Provider single-machine SPOF in Phase 1; horizontal scaling is Phase 2.
- CRDT garbage collection and checkpoint policy is pinned for alpha: Y-Sweet 0.9.1 default GC stays on, `MARKLAB_YSWEET_SKIP_GC=true` is rejected because the pinned server has no `--skip-gc` flag, and production checkpoint cadence is `MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS=10`.
- CLI transport (IPC to local app vs HTTPS to control plane) is left to the CLI implementation ticket; the user-facing contract for `wait-for-sync` and `status` is specified.
- Local persistence format for MarkLab.app's offline Y.Doc state is left to the app implementation ticket (y-leveldb or platform-native equivalent).
- `apps/web` (existing web shell) coexistence with `apps/collab-web` is left to the deployment ticket.
