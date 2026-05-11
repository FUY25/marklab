# Local File Sync MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. This plan is partially executed on the current branch; see "Execution Status" before starting new work.

**Goal:** Make `marklab open README.md` open one local Markdown file in MarkLab, keep browser edits and external local editor saves synchronized, and provide simple local snapshots and restore.

**Architecture:** The local API process acts as a lightweight daemon for one opened Markdown file. It registers the file as a local document, seeds a Hocuspocus/Yjs room from disk through the Milkdown transformer, watches the file for external saves, writes browser-originated room changes back to disk atomically, and applies external file saves back into the active room. Versions are local safety snapshots, not cloud branches.

**Tech Stack:** Node.js/TypeScript, Hocuspocus/Yjs, Milkdown/Crepe headless runtime, React, filesystem watcher, atomic writes, later SQLite or app-support metadata.

---

## Product Scope

This is the first local-first slice. It intentionally does not include hosted collaboration, cloud document creation, cloud import, visible admin token setup, AI write APIs, branch UI, or collaborator local mirrors.

The target workflow is:

```text
marklab open README.md
```

Acceptance behavior:

- The browser shows the contents of `README.md`.
- Browser edits are written back to `README.md`.
- Editing and saving `README.md` in Typora, VS Code, Cursor, Vim, Claude Code, Codex, or another local tool updates the browser without refresh.
- A second local browser window connected to the same room sees the same document and converges.
- Manual save creates a local snapshot.
- Restore writes the selected snapshot back to disk and updates all connected local browser windows.

## Product Principles

- The local Markdown file is canonical.
- MarkLab does not ask AI tools to call hosted write/edit APIs.
- Any local tool that edits the file is a valid writer.
- The browser editor is another view/editor over the same file, not the storage owner.
- Versions are local safety snapshots, not Git replacement and not branch UI.
- The UI should stay clean: editor canvas, Versions button, quiet status.
- No hidden cloud write path is allowed for this local-first mode.

## Local-Mode API Boundary

When `MARKLAB_LOCAL_FILE` is enabled, the process is a local daemon for one file, not a cloud document server.

Acceptance criteria:

- Only these surfaces are available by default:
  - `GET /healthz`
  - `GET/POST /api/local/*`
  - `/collab` for the single local room, guarded by the local daemon token
- Cloud document routes such as `/api/docs`, `/api/docs/import`, `/api/docs/:docId/branches/:branchId/write`, `/edit`, `/read`, cloud versions, and branch routes return `404` or `410` unless a deliberate cloud mode flag is enabled.
- Local mode must not create or require `documents`, `document_branches`, `document_branch_states`, or `document_versions`.
- Local mode must not expose hosted AI write/edit APIs as a hidden way to mutate the opened file.
- Local mode must reject any collab room other than the daemon's single `local:<localDocId>` room.

This is a security and product-boundary requirement. The user opened a local file, not a cloud workspace.

## Local Daemon Security

The local daemon can write a user's canonical Markdown file, so it needs a basic loopback safety model.

Acceptance criteria:

- Bind the local daemon to `127.0.0.1` by default, not `0.0.0.0`.
- Generate a per-daemon local token when `marklab open` starts.
- Pass that token to the web app through the launched local URL fragment or dev environment.
- The browser stores the token in `sessionStorage`, not durable local storage.
- The web app sends the token as `Authorization: Bearer <token>` for local API calls.
- The web app sends the token in the local collab websocket handshake.
- Require the token for all `/api/local/*` routes because read routes can expose local file contents.
- Require the token for `/collab` when the requested room is a local room because websocket edits can mutate the local file.
- Mutating local routes must additionally reject missing or invalid tokens:
  - `POST /api/local/flush`
  - `POST /api/local/versions/manual-save`
  - `POST /api/local/restore`
- Reject non-local `Host`/`Origin` where practical.
- Verify unauthenticated LAN or cross-origin calls cannot read or mutate the file.

The hosted relay in Plan 02 has a separate access model. This local token is only for localhost file-write protection.

## Execution Status

Current branch has a working core spike for this plan.

Completed:

- Local file service exists at `apps/api/src/local/local-file-service.ts`.
- Local routes exist at `apps/api/src/routes/local-file-routes.ts`.
- Hocuspocus can load/store local rooms through `CollabRoomStore` in `apps/api/src/collab/server.ts`.
- API can run local-file mode without `DATABASE_URL` when `MARKLAB_LOCAL_FILE` is set.
- `/local` web page exists at `apps/web/src/pages/LocalDocumentPage.tsx`.
- Home page hides cloud `New`, `Import`, and `Admin token` controls.
- Remote cloud document action rail no longer exposes new/import by default.
- `npx -y pnpm@10.0.0 marklab open README.md` launches the local dev flow from this repo.
- Manual smoke verified:
  - browser opens a local Markdown file;
  - browser edit writes to disk;
  - external file save updates browser;
  - two local browser windows converge;
  - manual snapshot route works;
  - restore updates both disk and active browser.

Not yet production-complete:

- Snapshots are in memory and disappear when the daemon restarts.
- No SQLite/app-support local metadata store yet.
- `marklab open` is a repo script, not a packaged/global command.
- No Playwright local-file sync spec yet.
- Conflict handling is protective but not a polished review UX.
- No recent local files launcher yet.
- No durable background daemon lifecycle management.

Treat the current branch as:

```text
core loop implemented and smoke-tested
production hardening still required
```

## Local Daemon Responsibilities

For one opened file, track:

```ts
type LocalFileDocument = {
  localDocId: string;
  absolutePath: string;
  displayName: string;
  roomName: string;
  lastDiskHash: string;
  currentHash: string;
  conflict: string | null;
};
```

The daemon must:

- Resolve the target Markdown path.
- Read the file as UTF-8.
- Initialize a Yjs room from Markdown through the Milkdown transformer.
- Watch the file's parent directory and filter events by basename.
- Debounce watcher events.
- Ignore MarkLab's own writes using content hashes.
- Serialize Yjs state to Markdown before writing the file.
- Write file changes atomically.
- Apply external file saves through the same live writer/runtime path.
- Create and restore local snapshots.

## Local Daemon Lifecycle

The local daemon is not an implementation detail. It is the product's local-first runtime.

Plan 01 must support two modes:

```text
marklab open README.md
```

Foreground mode. The terminal stays attached. Closing the terminal stops the local daemon.

```text
marklab open README.md --background
```

Background mode. The daemon keeps watching the file after the terminal command returns. The command prints the browser URL and how to stop the daemon.

Minimum lifecycle commands:

```text
marklab status
marklab stop README.md
marklab stop --all
```

Acceptance criteria:

- `marklab open <file> --background` resolves the canonical realpath and refuses or reuses an already-running daemon for the same file.
- Background mode survives browser tab close.
- Background mode survives terminal close.
- Background mode is still loopback-only and protected by the local daemon token.
- `marklab status` shows the local file path, browser URL, PID, port, and last sync state.
- `marklab stop README.md` shuts down the matching daemon cleanly.
- `marklab stop README.md` requests graceful shutdown: flush the active Yjs room through the normal serializer/conflict path, persist local metadata and snapshots, then exit.
- If shutdown flush fails, `marklab stop` exits non-zero, leaves the daemon running when possible, and prints the recovery/status command.
- The daemon registry lives in the user app-support directory, not in the project folder.
- The daemon registry is updated atomically and protected from concurrent open/stop races.
- Stale registry entries are cleaned up when the process no longer exists.
- Background mode does not create a workspace/sidebar/document manager.

The optional menubar in Plan 04 is a thin UI over this lifecycle layer. It should not invent a second daemon model.

## Sync Rules

Browser to local file:

```text
browser edit
  -> Yjs room changes
  -> debounce flush
  -> serialize Yjs through Milkdown
  -> if disk has not changed externally, atomic write Markdown to file
  -> update lastDiskHash
```

Local file to browser:

```text
external save
  -> watcher debounce
  -> read file and hash content
  -> ignore if hash equals lastDiskHash
  -> flush active Yjs room
  -> apply file Markdown through live writer/runtime
  -> persist returned non-empty yjsState
  -> apply yjsState to the active Hocuspocus/Y.Doc room
```

Restore:

```text
flush active Yjs room
  -> apply selected snapshot through live writer/runtime
  -> require non-empty yjsState
  -> atomic write restored Markdown to local file
  -> create rollback snapshot
  -> apply yjsState to active room
```

## Conflict Policy For Plan 01

Plan 01 avoids silent overwrite but does not implement a full conflict-review flow. Plan 03 owns the full reconnect/conflict review product.

Plan 01 behavior:

- If browser state wants to write the file but disk hash no longer matches the last known disk hash, do not overwrite the file.
- If the browser has unflushed active-room edits and the disk changes externally, do not apply the external file into the active room.
- Keep the active room and disk file recoverable.
- Keep the browser draft visible.
- Keep the disk file intact.
- Create or expose a recovery snapshot for the browser draft before any user choice.
- Show a quiet conflict state.

Initial UI copy:

```text
File changed outside MarkLab. Review needed.
```

The current spike must be hardened here. A watcher event must not erase the browser draft just because an external editor saved the file.

## Restore Safety

Restore must be reversible.

Acceptance criteria:

- Restore first flushes the active room.
- If current disk/live state differs from the selected snapshot, create a pre-restore recovery snapshot before overwriting disk.
- Then apply the selected snapshot through the same runtime/live-room path.
- Then write the selected snapshot to disk atomically.
- Then create a rollback snapshot of the restored content.
- Then apply the restored Yjs state to the active room.
- A user must be able to undo a restore after unsaved browser edits or external-file edits existed before restore.

## UI

Home page:

```text
MarkLab
Open a Markdown file from your terminal:
marklab open README.md
```

No cloud create button, import button, branch picker, document id form, or admin token panel in the local-first default UI.

Local document page:

```text
[clean Markdown editor canvas]

                                  [Versions]
```

Quiet status examples:

```text
Connected to local file
Saved to file
File changed outside MarkLab
Restored snapshot
```

## Remaining Implementation Tasks

### Task 0: Harden Local Mode Boundary And Token Guard

**Files:**

- Modify: `apps/api/src/http/app.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/collab/server.ts`
- Modify: `apps/api/src/routes/local-file-routes.ts`
- Modify: `apps/web/src/pages/LocalDocumentPage.tsx`
- Modify: `apps/cli/marklab.mjs`
- Test: `apps/api/src/routes/local-file-routes.test.ts`
- Test: `apps/api/src/collab/server.test.ts`

Acceptance criteria:

- `MARKLAB_LOCAL_FILE` mode does not mount cloud document, cloud version, branch, import, or hosted AI write routes unless an explicit cloud flag is enabled.
- Local API reads and writes require the per-daemon local token.
- Local collab websocket connections require the same token.
- Local collab rejects every room except the one room for the opened file.
- The daemon binds to `127.0.0.1` by default.
- The CLI passes the token to the browser through a URL fragment or equivalent non-persistent launch channel.
- Tests prove an unauthenticated HTTP caller cannot read local file metadata or mutate the file.
- Tests prove an unauthenticated websocket caller cannot join the local room.

### Task 1: Persist Local Metadata And Snapshots

**Files:**

- Create: `apps/api/src/local/local-metadata-store.ts`
- Modify: `apps/api/src/local/local-file-service.ts`
- Test: `apps/api/src/local/local-metadata-store.test.ts`

Store local state under the user's app-support directory by default:

```text
~/Library/Application Support/MarkLab/marklab-local.json
```

Use JSON first unless the implementation needs SQLite immediately. Keep the storage replaceable behind an interface:

```ts
export interface LocalMetadataStore {
  loadDocument(absolutePath: string): Promise<StoredLocalDocument | null>;
  saveDocument(document: StoredLocalDocument): Promise<void>;
  listVersions(localDocId: string): Promise<StoredLocalVersion[]>;
  appendVersion(version: StoredLocalVersion): Promise<void>;
}
```

Required stored shapes:

```ts
type StoredLocalDocument = {
  schemaVersion: 1;
  localDocId: string;
  absolutePath: string;
  displayName: string;
  roomName: string;
  lastDiskHash: string;
  currentHash: string;
  currentYjsStateBase64: string;
  updatedAt: string;
};

type StoredLocalVersion = {
  schemaVersion: 1;
  versionId: string;
  localDocId: string;
  versionNumber: number;
  operation:
    | 'open'
    | 'manual_save'
    | 'pre_restore'
    | 'rollback'
    | 'conflict_recovery';
  markdownSnapshot: string;
  yjsStateBase64: string;
  hash: string;
  createdAt: string;
};
```

Acceptance criteria:

- Metadata writes are atomic: write temporary sibling file, then rename.
- Corrupt metadata does not block opening the Markdown file; it starts with a fresh local state and reports that local history could not be loaded.
- Open file, save snapshot, stop daemon, reopen same file, versions still list.
- Version preview works after daemon restart.
- Restore works after daemon restart.
- Tests can override the metadata path so they never touch the real user app-support directory.

Do not create `.marklab/` in the user's project by default.

### Task 2: Add Local Sync Playwright Spec

**Files:**

- Create: `apps/web/tests/local-file-sync.spec.ts`
- Modify: `apps/web/playwright.config.ts` or create a test fixture that starts local-file API/web explicitly.
- Modify: `apps/web/tests/setup-remote-api.ts` only if shared helpers are useful.

Cover:

- browser opens local file;
- browser edit writes to disk;
- external file save updates browser;
- second browser receives browser-originated update;
- save snapshot then restore updates disk and browser.
- conflict state appears in browser within a bounded time after conflicting external save.
- tests use temp Markdown files and never touch repo `README.md`.

### Task 3: Package The Local Command

**Files:**

- Modify: `apps/cli/marklab.mjs`
- Modify: `package.json`

Make the documented command reliable from the repo:

```text
npx -y pnpm@10.0.0 marklab open README.md
```

Global install/linking can wait.

Acceptance criteria:

- Bind API/web to loopback by default.
- Choose unused ports or report the conflict clearly.
- If either API or web child process exits, the parent reports failure and shuts down the other child.
- Ctrl-C leaves no orphan child processes.
- The launched URL includes or configures the local daemon token.
- Watcher shutdown closes cleanly.

### Task 4: Minimal Background Daemon Lifecycle

**Files:**

- Modify: `apps/cli/marklab.mjs`
- Create: `apps/cli/daemon-supervisor.mjs`
- Modify: `apps/api/src/local/local-metadata-store.ts`
- Test: `apps/cli/daemon-supervisor.test.mjs`
- Test: `apps/cli/marklab-cli.test.mjs`

Add:

```text
marklab open README.md --background
marklab status
marklab stop README.md
marklab stop --all
```

Acceptance criteria:

- Foreground `marklab open README.md` keeps the current transparent terminal behavior.
- Background `marklab open README.md --background` starts the same local file daemon detached from the terminal.
- The background command prints:
  - opened file path;
  - browser URL;
  - whether sync is running;
  - exact stop command.
- `marklab status` lists running MarkLab daemons from the app-support registry.
- `marklab status` removes stale entries when the recorded PID is gone.
- `marklab stop README.md` stops only the daemon for that file.
- `marklab stop --all` stops every local daemon started by MarkLab.
- Background daemons keep loopback bind and token protection from Task 0.
- Closing the browser tab does not stop the daemon.
- Closing the launching terminal does not stop a background daemon.
- Duplicate background open for the same canonical realpath refuses or reuses the already-running daemon.
- Stop with dirty browser state flushes first or fails without stopping the daemon.
- App-support registry writes are atomic and race-safe for concurrent open/stop.
- Tests prove no orphan child process remains after stop.

Do not build a menubar, launch agent, auto-start service, or native app in Plan 01. Plan 01 only creates the lifecycle foundation.

### Task 5: Basic Conflict State UX

**Files:**

- Modify: `apps/api/src/local/local-file-service.ts`
- Modify: `apps/web/src/pages/LocalDocumentPage.tsx`

If a conflict is detected, show:

```text
File changed outside MarkLab. Review needed.
```

Delivery mechanism:

- The browser must learn about daemon-detected conflict without requiring another browser edit.
- Polling every 1-2 seconds is acceptable for this MVP.
- SSE or awareness-state messaging is also acceptable, but do not build a heavy event system only for this.

Do not attempt AI merge or choose-side UI in Plan 01. Plan 03 owns that.

### Task 6: Markdown Preservation Fixtures

**Files:**

- Create: `apps/api/src/local/local-file-service.test.ts`
- Use fixtures from `fixtures/`.

Acceptance criteria:

- Opening a file does not rewrite it.
- First MarkLab-originated save may canonicalize only through known Milkdown/canonicalization rules.
- Supported Markdown structures survive external edit -> browser room -> disk round trips.
- Cover at least:
  - `fixtures/03_code_mermaid_frontmatter.md`
  - `fixtures/04_math_links_images.md`
  - tables/lists/task-list fixture if present.

### Task 7: Local-First Documentation Cleanup

**Files:**

- Modify: `README.md`
- Create: `docs/product/local-first-user-journeys.md`
- Create: `docs/product/local-url-vs-relay-url.md`
- Modify: `docs/Archive/cloud-first-reference/README.md` if archive index does not exist.
- Modify or archive root legacy spec docs `00_*.md` through `09_*.md`.

The root README currently describes the legacy cloud-first product where AI agents read/write a hosted document. That is now misleading and will teach future agents the wrong behavior.

Rewrite the public docs around the current product:

```text
MarkLab is a local-first Markdown collaboration tool.
The local .md file is canonical.
The browser is an editor/view over that file.
AI agents edit local files, not hosted write APIs.
Hosted relay exists for sharing, identity, permissions, and live transport.
```

Acceptance criteria:

- Root README starts with `marklab open README.md` as the primary workflow.
- Root README does not present hosted AI write/edit APIs as the product path.
- Root README explains foreground versus background daemon behavior.
- Root README explains that local browser URLs are private and relay links are shareable.
- Root README links to the active plans `01` through `06`.
- Legacy cloud-first plans are clearly labeled as archived reference, not current execution plans.
- No root-level Markdown file can be mistaken for the current product direction.
- Every superseded cloud-first root spec has a first-screen banner: `Historical cloud-first reference. Superseded by docs/appdesigndoc.md; previous local-first plans are archived under docs/Archive/local-first-plans/.`
- README links the active local-first plans before any historical reference.
- `docs/product/local-first-user-journeys.md` covers:
  - solo local file;
  - browser collaborator;
  - local mirror collaborator;
  - host offline;
  - reconnect conflict;
  - AI agent editing local files.
- `docs/product/local-url-vs-relay-url.md` states:
  - local URL includes daemon access and must not be shared;
  - relay URL is the shareable collaboration URL;
  - view link is browser-only;
  - edit link can be browser edit or local mirror join.

## Gstack Plan Review Closure

Engineering review questions addressed in this revision:

- Local mode has an explicit route boundary and must not expose cloud document/import/AI write APIs.
- Local HTTP routes and local collab websocket require the per-daemon local token.
- Local collab accepts only the one room for the opened file.
- Local snapshots must be durable across daemon restarts.
- Background daemon lifecycle is part of Plan 01 so local-first sync is not tied to an open terminal forever.
- External file saves must not silently erase dirty browser drafts.
- Restore is reversible and updates disk plus active room state.
- Local sync requires Playwright coverage with temp Markdown files.
- Root documentation cleanup is part of Plan 01 so agents do not learn the legacy cloud-first product story.

## Verification

Minimum checks:

```text
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test apps/api/src/local/local-file-service.test.ts apps/api/src/local/local-metadata-store.test.ts
npx -y pnpm@10.0.0 test apps/cli/daemon-supervisor.test.mjs apps/cli/marklab-cli.test.mjs
npx -y pnpm@10.0.0 test apps/api/src/collab/server.test.ts apps/api/src/routes/version-routes.test.ts apps/api/src/services/editor-state.test.ts
rg -n "/api/docs/.*/(write|edit)|marklab (write|edit|hosted-write|hosted-edit)|read_doc|write_doc|edit_doc|branchable history" README.md docs/product && exit 1 || true
rg -n "(should|must|can) (call|use).*hosted.*(write|edit)|hosted.*(write|edit).*as the product path" README.md docs/product && exit 1 || true
for f in 0*.md; do head -20 "$f" | rg -q "Historical cloud-first reference|Superseded by.*local-first" || exit 1; done
git diff --check
```

Manual E2E:

```text
1. Run npx -y pnpm@10.0.0 marklab open README.md.
2. Confirm the browser shows README.md.
3. Edit in the browser and confirm README.md changes on disk.
4. Edit README.md in a local editor and save.
5. Confirm the browser updates without refresh.
6. Open a second browser window to the same local route and confirm both windows converge.
7. Save a snapshot.
8. Change the file.
9. Restore the snapshot and confirm file plus both browser windows show restored content.
10. Run marklab open README.md --background.
11. Close the launching terminal and confirm README.md still syncs with the browser.
12. Run marklab status and confirm the file is listed.
13. Run marklab stop README.md and confirm sync stops cleanly.
```
