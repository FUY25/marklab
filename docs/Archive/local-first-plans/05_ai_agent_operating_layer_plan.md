# AI Agent Operating Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach AI coding agents how to operate MarkLab safely through CLI/status commands while keeping all content writes as normal local Markdown file edits.

**Architecture:** MarkLab exposes a stable agent-facing CLI contract, machine-readable JSON output, and installable instruction snippets for Codex, Claude Code, Cursor, and similar local agents. Agents may start/stop/status/share/wait/save-version through MarkLab, but they must not call hosted write/edit APIs or mutate Yjs/Postgres directly. The local Markdown file remains the write surface.

**Tech Stack:** Node.js CLI, JSON schemas, local daemon registry from Plan 01, relay share-state contract from Plan 02, conflict APIs from Plan 03, docs/agent instruction templates.

---

## Product Scope

This plan starts after Plan 01 has local sync, metadata, and daemon lifecycle commands.

It can be partially implemented before Plan 02/03, but relay and conflict commands should return explicit unavailable states until those plans land.

In scope:

- agent-readable CLI output;
- stable CLI exit codes and error codes;
- agent instruction documents and install commands;
- `wait --synced` so agents can verify watcher/relay convergence;
- `save-version` so agents can checkpoint before broad edits;
- `doctor` for environment diagnosis;
- `recent` for lightweight file discovery;
- agent guardrails that ban hosted write/edit APIs.

Out of scope:

- hosted AI writing;
- MCP server as the primary contract;
- automatic AI merge;
- direct Yjs editing by agents;
- direct Postgres writes by agents;
- a custom agent runtime.

## Product Principles

- AI controls MarkLab processes.
- AI edits local Markdown files.
- MarkLab watches and syncs local Markdown files.
- Hosted relay is not an AI write surface.
- Agent commands must be scriptable and deterministic.
- Human-readable CLI output is useful, but every agent workflow needs `--json`.
- Agents may save versions before edits.
- Agents must not restore versions unless the user explicitly asks.
- Agents must not resolve conflicts without explicit user instruction.

## Agent Workflow

Small edit:

```text
marklab status README.md --json
edit README.md locally
marklab wait README.md --synced --timeout 10000 --json
report changed file and sync state
```

Large edit:

```text
marklab status README.md --json
marklab save-version README.md --message "Before AI edit: <reason>" --json
edit README.md locally
marklab wait README.md --synced --timeout 10000 --json
report version id and sync state
```

Conflict state:

```text
marklab status README.md --json
marklab conflict README.md --json
```

If `syncState` is `paused`, the agent must not keep editing the watched file. It can help by writing a resolved draft to a temporary file or by producing text for the user to paste into the conflict review UI.

## Agent Command Contract

All agent-facing commands support `--json` and stable error codes.

Required commands:

```text
marklab status [file] --json
marklab wait <file> --synced --timeout 10000 --json
marklab save-version <file> --message "Before AI edit" --json
marklab versions <file> --json
marklab recent --json
marklab doctor --json
marklab share <file> --json
marklab create-link <file> --role view --json
marklab create-link <file> --role edit --json
marklab revoke-link <file> <grant-id> --json
marklab share-state <file> --json
marklab conflict <file> --json
marklab agent instructions --target codex
marklab agent instructions --target claude
marklab agent instructions --target cursor
marklab agent install --target codex --write AGENTS.md
```

Forbidden commands:

```text
marklab write <file> ...
marklab edit <file> ...
marklab hosted-write ...
marklab hosted-edit ...
```

MarkLab must not introduce local content-write commands for agents. Agents use their own file editing tools.

## JSON Shapes

Status:

```ts
type AgentStatusResponse = {
  ok: true;
  files: Array<{
    path: string;
    displayName: string;
    daemon: 'running' | 'stopped' | 'missing';
    mode: 'local' | 'relay-host' | 'relay-mirror';
    syncState: 'synced' | 'saving' | 'dirty' | 'paused' | 'host_offline' | 'error';
    browserUrl: string | null;
    pid: number | null;
    port: number | null;
    lastSyncAt: string | null;
    hasConflict: boolean;
    relayRoomId: string | null;
  }>;
};
```

Wait:

```ts
type AgentWaitResponse = {
  ok: true;
  path: string;
  syncState: 'synced';
  observedHash: string;
  versionId: string | null;
  relayRevision: number | null;
  waitedMs: number;
};
```

Error:

```ts
type AgentErrorResponse = {
  ok: false;
  code:
    | 'file_not_watched'
    | 'daemon_not_running'
    | 'sync_timeout'
    | 'sync_paused'
    | 'host_offline'
    | 'conflict_required'
    | 'conflict_unavailable'
    | 'relay_unavailable'
    | 'share_not_started'
    | 'forbidden_agent_write'
    | 'doctor_failed'
    | 'invalid_target';
  message: string;
  details?: Record<string, unknown>;
};
```

Exit codes:

```text
0 success
1 general failure
2 invalid command or target
3 daemon not running
4 sync paused or conflict required
5 host offline
6 timeout
7 environment/doctor failure
8 feature unavailable or dependency unavailable
```

## File Structure

Create or modify:

```text
apps/cli/agent-json.mjs
apps/cli/agent-instructions.mjs
apps/cli/doctor.mjs
apps/cli/wait-for-sync.mjs
apps/cli/recent-files.mjs
apps/cli/marklab.mjs
apps/cli/package.json
docs/agent/marklab-agent-guide.md
docs/agent/marklab-codex-instructions.md
docs/agent/marklab-claude-code-instructions.md
docs/agent/marklab-cursor-instructions.md
docs/agent/README.md
docs/product/local-first-user-journeys.md
README.md
```

## Task 1: Agent JSON And Exit-Code Foundation

**Files:**

- Create: `apps/cli/agent-json.mjs`
- Modify: `apps/cli/marklab.mjs`
- Test: `apps/cli/agent-json.test.mjs`

- [ ] Add a shared JSON response helper for success and error output.
- [ ] Add stable error codes from `AgentErrorResponse`.
- [ ] Add stable process exit codes.
- [ ] Ensure `--json` writes only JSON to stdout.
- [ ] Ensure human-readable diagnostics go to stderr when `--json` is active.

Acceptance criteria:

- Agent commands produce parseable JSON on stdout.
- Error responses include `ok: false`, `code`, and `message`.
- Tests assert exit code and stdout shape for success and failure.

## Task 2: Agent Status, Recent, And Wait

**Files:**

- Modify: `apps/cli/marklab.mjs`
- Create: `apps/cli/wait-for-sync.mjs`
- Create: `apps/cli/recent-files.mjs`
- Modify: `apps/cli/daemon-supervisor.mjs`
- Test: `apps/cli/agent-status.test.mjs`
- Test: `apps/cli/wait-for-sync.test.mjs`

- [ ] Implement `marklab status [file] --json`.
- [ ] Implement `marklab recent --json` using the Plan 01 app-support registry.
- [ ] Implement `marklab wait <file> --synced --timeout 10000 --json`.
- [ ] Make `wait` return `sync_paused` immediately when conflict state is open.
- [ ] Make `wait` return `host_offline` immediately for relay mirror/host states that cannot sync.
- [ ] Make `wait` timeout without mutating files.

Acceptance criteria:

- An agent can determine whether a file is watched before editing.
- An agent can wait until MarkLab has observed a local file edit.
- `recent --json` is a lightweight file list, not a workspace/sidebar model.

## Task 3: Agent Save-Version And Version Listing

**Files:**

- Modify: `apps/cli/marklab.mjs`
- Modify: `apps/api/src/routes/local-file-routes.ts`
- Test: `apps/cli/agent-version.test.mjs`
- Test: `apps/api/src/routes/local-file-routes.test.ts`

- [ ] Implement `marklab save-version <file> --message "..." --json`.
- [ ] Implement `marklab versions <file> --json`.
- [ ] Store agent-created version metadata with operation `manual_save` and source `agent`.
- [ ] Reject restore from agent commands unless the user invokes an explicit future restore command.

Acceptance criteria:

- Agents can checkpoint before broad edits.
- Version listing never exposes local daemon token.
- There is no `marklab restore` in this plan.

## Task 4: Doctor For Agent And Human Debugging

**Files:**

- Create: `apps/cli/doctor.mjs`
- Modify: `apps/cli/marklab.mjs`
- Test: `apps/cli/doctor.test.mjs`

- [ ] Implement `marklab doctor --json`.
- [ ] Check Node version compatibility.
- [ ] Check CLI package installation mode.
- [ ] Check loopback bind availability.
- [ ] Check API/web port conflicts.
- [ ] Check target file read/write permissions when a file is supplied.
- [ ] Check watcher can observe a temp file change.
- [ ] Check Milkdown headless runtime can initialize.
- [ ] Check relay URL reachability when configured.
- [ ] Report warnings for iCloud/Dropbox/network-drive paths without failing by default.

Acceptance criteria:

- Doctor output separates `errors` and `warnings`.
- Doctor never changes the user's Markdown file.
- Doctor catches the runtime class of failures that would otherwise show as browser `Failed to fetch` or daemon crash.

## Task 5: Agent Instruction Documents

**Files:**

- Create: `docs/agent/README.md`
- Create: `docs/agent/marklab-agent-guide.md`
- Create: `docs/agent/marklab-codex-instructions.md`
- Create: `docs/agent/marklab-claude-code-instructions.md`
- Create: `docs/agent/marklab-cursor-instructions.md`
- Create: `apps/cli/agent-instructions.mjs`
- Modify: `apps/cli/marklab.mjs`
- Test: `apps/cli/agent-instructions.test.mjs`

- [ ] Write the general agent guide.
- [ ] Write Codex-specific instructions.
- [ ] Write Claude Code-specific instructions.
- [ ] Write Cursor-specific instructions.
- [ ] Implement `marklab agent instructions --target codex`.
- [ ] Implement `marklab agent instructions --target claude`.
- [ ] Implement `marklab agent instructions --target cursor`.
- [ ] Implement `marklab agent install --target codex --write AGENTS.md`.
- [ ] Require explicit `--write` for any project-file mutation.

Acceptance criteria:

- Instructions say agents edit local Markdown files, not hosted APIs.
- Instructions say agents may control MarkLab through CLI.
- Instructions say agents must not edit watched conflicted files while sync is paused.
- Instructions say agents should save a version before broad edits.
- Install command never overwrites an existing instruction file without confirmation or `--force`.

## Task 6: Relay And Conflict Integration

**Files:**

- Modify: `apps/cli/marklab.mjs`
- Modify: `apps/cli/relay-config.mjs`
- Test: `apps/cli/agent-relay.test.mjs`
- Test: `apps/cli/agent-conflict.test.mjs`

- [ ] Implement `marklab share-state <file> --json` as specified in Plan 02.
- [ ] Implement `marklab share <file> --json` with stable success and error JSON.
- [ ] Implement `marklab create-link <file> --role view --json`.
- [ ] Implement `marklab create-link <file> --role edit --json`.
- [ ] Implement `marklab revoke-link <file> <grant-id> --json`.
- [ ] Implement `marklab conflict <file> --json` when Plan 03 conflict APIs exist.
- [ ] Before Plan 03 lands, return `conflict_unavailable` for files without conflict support.
- [ ] Ensure share-state identifies view/edit links and active sessions.
- [ ] Ensure share-state does not expose raw local daemon tokens or raw relay token hashes.

Acceptance criteria:

- Agents can inspect share state but cannot mutate document content through share-state.
- Plan 02 share/link commands support `--json`, stable `AgentErrorResponse`, and stable exit codes.
- Agents can start sharing and create/revoke relay grants without any hosted content-write API.
- Link creation returns a copyable raw URL once; share-state does not reconstruct URLs from token hashes.
- Agents can detect conflict and stop local edits.
- Conflict JSON includes enough state for the agent to tell the user what to do next without resolving automatically.

## Task 7: README Integration

**Files:**

- Modify: `README.md`
- Modify: `docs/product/local-first-user-journeys.md`

- [ ] Link to `docs/agent/marklab-agent-guide.md`.
- [ ] Add a section: "Using MarkLab with Codex, Claude Code, or Cursor".
- [ ] State that MarkLab does not provide hosted write/edit APIs for AI agents.
- [ ] Show the small-edit and large-edit workflows.
- [ ] Show `marklab agent instructions --target codex`.

Acceptance criteria:

- A new AI agent reading README learns local file editing first.
- README does not direct agents to cloud document write routes.
- README and docs/agent agree on command names.

## Verification

Minimum checks:

```text
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test apps/cli/agent-json.test.mjs apps/cli/agent-status.test.mjs apps/cli/wait-for-sync.test.mjs apps/cli/agent-version.test.mjs apps/cli/doctor.test.mjs apps/cli/agent-instructions.test.mjs
npx -y pnpm@10.0.0 test apps/cli/agent-relay.test.mjs apps/cli/agent-conflict.test.mjs
rg -n "/api/docs/.*/(write|edit)|marklab (write|edit|hosted-write|hosted-edit)|read_doc|write_doc|edit_doc|direct Yjs|direct Postgres" docs/agent README.md && exit 1 || true
rg -n "(should|must|can) (call|use).*hosted.*(write|edit)|hosted.*(write|edit).*as the product path" docs/agent README.md && exit 1 || true
git diff --check
```

Manual acceptance:

```text
1. Run marklab open README.md --background.
2. Run marklab status README.md --json and parse it with jq.
3. Run marklab save-version README.md --message "Before agent edit" --json.
4. Edit README.md using a normal file edit.
5. Run marklab wait README.md --synced --timeout 10000 --json.
6. Run marklab doctor --json.
7. Run marklab agent instructions --target codex.
8. Confirm the instructions never mention hosted write/edit APIs.
```
