# Native Background Sharing CLI And Menu Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for implementation. Use spawned code review after implementation slices; run at most three review/fix rounds before final verification.

**Goal:** Make `marklab share <file.md> --edit|--view` a native MarkLab.app automation path that can start sharing in the background, keep the local file synced after the editor window closes, and expose a simple macOS menu bar status surface for active shared documents.

**Architecture:** MarkLab.app owns shared-document lifecycle. The CLI is a local control client that requests native work, waits for a native response, and prints/copies links. It must not restart the archived local daemon or mint old `/relay` links.

**Tech Stack:** Existing `apps/cli` Node CLI, `apps/marklab-macos` SwiftPM app, native control-plane share client, native binding store, Swift tests, Vitest/Node tests.

---

## Product Decisions

- `marklab share <file.md> --edit` creates or reuses the native shared document session, creates an edit link, copies it to the clipboard, and prints it.
- `marklab share <file.md> --view` does the same for a view link.
- `--json` returns structured output with `ok`, `role`, `file`, `url`, `copied`, `docId`, `branchId`, and `grantId` when available.
- `marklab share <file.md>` without `--edit` or `--view` should fail with a clear usage error. A link role is required because this command now creates a link without human UI selection.
- MarkLab.app may launch in the background to process the share request. The document window does not need to open.
- Closing a document window does not stop sync for an active shared file. Background sync is owned by the shared-document session manager.
- The menu bar UI is intentionally small: one row per shared document, a status light or pill, last sync time, and an Open action when clicked.
- Menu bar UI is not a full collaboration inspector. Link management and collaborator details stay in the document inspector.
- AI agents are not displayed as collaborators. Agent edits happen by editing the local Markdown file; the active native session ingests the disk change.

## Scope

This plan implements native background sharing and pilot-quality status visibility. It does not implement Stripe billing, paid plan selection, or admin plan mutation. It does not revive the old local daemon route.

## File Structure

- Modify `apps/cli/marklab.mjs`
- Modify or add focused CLI tests in `apps/cli/*.test.mjs`
- Add a native CLI request/response bridge under `apps/marklab-macos/Sources/MarkLabMacOS/`
- Add a native background shared-document session manager under `apps/marklab-macos/Sources/MarkLabMacOS/`
- Modify `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`
- Modify or add MarkEdit shell integration in `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/`
- Add Swift tests under `apps/marklab-macos/Tests/MarkLabMacOSTests/`
- Update `apps/cli/README.md`
- Rewrite `docs/agent/README.md` and target-specific agent docs after the CLI behavior is final

## Native Control Protocol

Implement a local request/response protocol between CLI and MarkLab.app:

1. CLI writes a request JSON file under the MarkLab app-support directory, for example `cli-requests/<requestId>.json`.
2. CLI launches MarkLab.app in the background with the request id, using the existing app launch path plus a new native command argument or URL handoff.
3. MarkLab.app consumes pending requests, validates the file path and role, starts or reuses a shared-document session, creates the requested access link through the native control-plane client, copies the link to the clipboard, and writes `cli-responses/<requestId>.json`.
4. CLI waits for the response up to a bounded timeout, prints human or JSON output, and returns a non-zero exit code on timeout, native unavailable, conflict, auth, quota, or provider errors.
5. Request/response files are local-user state only and should not expose provider internals beyond the user-facing share link.

The implementation can choose `marklab://cli-request?id=...` or a launch argument for the app wake-up. The test contract is the request/response protocol, not the transport detail.

## Shared Session Manager

Introduce or formalize a native session manager that owns active shared files independent of document windows:

- Restores persisted bindings at app launch.
- Keeps watching local files while sharing is on.
- Projects local disk changes to the provider through the existing native collaboration runtime.
- Projects provider changes back to the local file.
- Tracks `syncing`, `synced`, `offline`, `conflict`, and `error` status.
- Tracks `lastSyncAt`.
- Lets document windows attach/detach from a session without destroying the session.
- Stops a session only through an explicit sharing-off action or unrecoverable revoked/auth state.

## CLI Behavior

### `marklab share`

Required forms:

```bash
marklab share file.md --edit
marklab share file.md --view
marklab share file.md --edit --json
marklab share file.md --view --json
```

Expected behavior:

- Validates the file exists and is Markdown.
- Does not require `MARKLAB_ENABLE_LEGACY_CLI=1`.
- Does not call the archived daemon.
- Starts MarkLab.app in the background if needed.
- Returns only after the native app has created the requested link or returned a typed failure.
- Copies the created link to clipboard and reports that it did so.

### `marklab wait` and `marklab conflict`

Keep these as agent support commands:

- `marklab wait <file.md> --synced --json` waits for the native shared session to report synced.
- `marklab conflict <file.md> --json` reports the native conflict state.
- They read native support state; they do not call provider APIs directly and do not use the archived daemon.

## Menu Bar UI

Menu bar status item:

- Shows only when MarkLab.app is running.
- Lists shared documents.
- Each row shows:
  - document name;
  - status light or compact status pill;
  - last sync time, using a short relative label such as `Synced 2m ago`;
  - conflict/error state when present.
- Clicking a row opens the document window for that shared file.
- If no documents are shared, show `No Shared Documents`.
- Include a minimal `Open MarkLab` or `Quit MarkLab` item only if it fits existing app conventions.

Status labels:

- `Synced`
- `Syncing`
- `Offline`
- `Conflict`
- `Error`

The menu bar should not duplicate the document collaboration inspector. It is a monitoring and re-open surface.

## Agent Documentation

After implementation, rewrite the agent docs around the new contract:

- Use `marklab share <file.md> --edit|--view` to create a user-facing access link.
- Edit local Markdown files directly.
- Prefer small surgical edits over rewriting whole files, because local file diffs are the safest agent boundary.
- Run `marklab wait <file.md> --synced --json` after editing a shared file.
- Run `marklab conflict <file.md> --json` if sync fails or before risky edits.
- Do not use old daemon commands, provider internals, Yjs internals, raw database writes, or hidden `/relay` routes.

## TDD Tasks

### Task 1: CLI Share Role Contract

- [ ] Add failing CLI tests for `marklab share <file.md> --edit`, `--view`, `--json`, and missing-role usage.
- [ ] Add failing tests proving `marklab share --edit|--view` is allowed without `MARKLAB_ENABLE_LEGACY_CLI=1`.
- [ ] Add failing tests proving it does not call the archived local daemon.
- [ ] Implement parsing and dispatch only after the tests fail for the expected reason.

### Task 2: Native Request/Response Bridge

- [ ] Add failing Node tests for request JSON creation, bounded response waiting, success output, timeout, and typed error output.
- [ ] Add failing Swift tests for reading a pending share request and writing a response.
- [ ] Implement the bridge in the smallest focused modules.
- [ ] Acceptance: CLI tests pass without requiring a running GUI app by using a deterministic fake native response.

### Task 3: Background Shared Session Manager

- [ ] Add failing Swift tests proving a shared session remains active after a document window detaches.
- [ ] Add failing Swift tests proving `lastSyncAt` updates when a projection succeeds.
- [ ] Add failing Swift tests for status transitions: `syncing`, `synced`, `offline`, `conflict`, and `error`.
- [ ] Implement or refactor the native session manager to satisfy those tests using existing native collaboration/runtime primitives.

### Task 4: Native Share Link Creation From CLI Request

- [ ] Add failing Swift tests proving a share request starts or reuses the native shared session.
- [ ] Add failing Swift tests proving edit and view links call the native control-plane client with the requested role.
- [ ] Add failing Swift tests proving the link is copied to the pasteboard by an injectable pasteboard abstraction.
- [ ] Implement request handling against the existing native share controller/control-plane client.

### Task 5: Menu Bar Status UI

- [ ] Add failing Swift tests for a menu bar view model: empty state, document rows, status labels, last sync labels, and open-document action.
- [ ] Implement the status item/menu model without duplicating the document inspector.
- [ ] Wire the menu bar model to the shared session manager.

### Task 6: Agent Docs And Help Text

- [ ] Add or update tests that assert agent docs mention only the current CLI contract and local-edit behavior.
- [ ] Rewrite `docs/agent/*` after CLI behavior is final.
- [ ] Update CLI help and `apps/cli/README.md`.

### Task 7: Verification

- [ ] Run targeted CLI tests.
- [ ] Run Swift tests.
- [ ] Run root `npx -y pnpm@10.0.0 test`.
- [ ] Run `npx -y pnpm@10.0.0 typecheck`.
- [ ] Run native/browser smoke if native runtime changes touch sync behavior.
- [ ] Run `git diff --check`.

## Code Review Gate

Run spawned Codex code review after implementation slices:

1. Review round 1 after the CLI bridge and native request processor pass targeted tests.
2. Review round 2 after the background session manager and menu bar status model pass Swift tests.
3. Review round 3 only if earlier review or verification finds material risk.

Each review must produce either no findings or actionable findings with file/line references. Fix findings before the final push unless explicitly deferred in this plan.

## Acceptance Criteria

- `marklab share file.md --edit` creates, copies, and prints an edit link through MarkLab.app without opening a required document window.
- `marklab share file.md --view` creates, copies, and prints a view link through MarkLab.app without opening a required document window.
- The old local daemon route remains inactive unless explicitly opted into for archived compatibility.
- A shared file remains synced after its editor window is closed.
- Menu bar shows active shared documents, status, and last sync time.
- Clicking a menu bar document row opens the document window.
- Agent docs describe only the current native CLI/local-edit convention.
- Automated tests cover the new CLI, native request bridge, background session state, and menu bar view model.
