# CLI and Agent Skill Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MarkLab CLI and MarkLab agent skill so Codex/Claude Code can read cloud docs and submit simple online `edit_doc` / `write_doc` operations safely.

**Architecture:** The CLI is a thin wrapper over the HTTP API. It does not own approval, reject/accept state, default local proposal snapshots, or server-side previews. The skill is the policy layer: it teaches agents when to use exact `edit_doc`, when to use guarded `write_doc`, and when to explain a proposed change in chat before writing. MCP is optional later.

**Tech Stack:** Node.js CLI, TypeScript, Commander, Zod, existing REST API, Codex/Claude skill Markdown.

---

## Prerequisites

Plan 6.2 must be complete before this plan starts. The CLI wraps the live HTTP API, so `read_doc`, `edit_doc`, `write_doc`, `import-doc`, `export-doc`, and version commands must already operate against real Milkdown/Yjs state. In particular, export must return a filename whose version/hash match the exported body, and write/edit must return `versionId`, `versionNumber`, and `hash` after persisting the returned Yjs state transactionally.

## File Structure

- Create: `apps/cli/package.json` - MarkLab CLI package.
- Create: `apps/cli/tsconfig.json` - CLI TypeScript config.
- Create: `apps/cli/src/config.ts` - local config and auth token loading.
- Create: `apps/cli/src/client.ts` - HTTP API wrapper.
- Create: `apps/cli/src/commands.ts` - command registration.
- Create: `apps/cli/src/index.ts` - CLI entrypoint.
- Test: `apps/cli/src/client.test.ts`.
- Create: `skills/marklab/SKILL.md` - agent workflow skill.

## Scope Check

This plan replaces the previous MCP-first and local-snapshot-first Plan 7. MCP is not on the MVP critical path. It can be added later as a thin adapter over the same API/CLI semantics after the CLI + skill workflow is proven.

The CLI must not implement user-level `accept`, `reject`, `submit-snapshot`, server-side `preview_doc_change`, `apply_doc_change`, change-set persistence, default local proposal snapshots, or public `multi_edit_doc`.

## CLI Command Surface

Required MVP commands:

```text
marklab config set-api-url <url>
marklab config set-token <token>
marklab health

marklab read-doc --doc <docId> --branch <branchId> [--out <path>] [--json]
marklab edit-doc --doc <docId> --branch <branchId> --old-string <text> --new-string <text> [--replace-all] [--observed-version <versionId>]
marklab write-doc --doc <docId> --branch <branchId> --base-version <versionId> --base-hash <hash> [--from <file.md> | --stdin]

marklab versions list --doc <docId> [--branch <branchId>]
marklab versions show --doc <docId> --version <versionId>
marklab export-doc --doc <docId> --branch <branchId> --out <dir>
marklab import-doc --title <title> --from <file.md>
```

Later commands:

```text
marklab branch-from-version --doc <docId> --version <versionId> --name <name>
marklab restore-version --doc <docId> --branch <branchId> --version <versionId>
```

## Agent Policy

Use `edit_doc` when the change is one small exact replacement and `oldString` should match the current canonical Markdown exactly. `edit_doc` does not require current hash equality.

Use `write_doc` when the change affects multiple regions, changes structure, rewrites prose, deletes content, or cannot be represented as one exact replacement. `write_doc` requires `baseVersionId` and `baseHash` from a fresh `read_doc`.

If `write_doc` returns `live_yjs_state_changed`, call `read_doc` again and rebuild the full target Markdown from the latest returned document. Do not retry the same full-document body against the old base.

Before `write_doc`, the skill must instruct the model to explain the proposed change in chat. For high-stakes or meaningful changes, include a concise diff or before/after excerpt. The MarkLab server does not persist preview objects in MVP.

## Task 1: CLI package setup

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Modify: `package.json`

- [ ] **Step 1: Create CLI package**

Create `apps/cli/package.json`:

```json
{
  "name": "@marklab/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "marklab": "./dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create CLI TypeScript config**

Create `apps/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run:

```bash
pnpm install
```

Expected: install completes and workspace links `@marklab/cli`.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/package.json apps/cli/tsconfig.json package.json pnpm-lock.yaml
git commit -m "chore: add marklab cli package"
```

## Task 2: API client and config

**Files:**
- Create: `apps/cli/src/config.ts`
- Create: `apps/cli/src/client.ts`
- Test: `apps/cli/src/client.test.ts`

- [ ] **Step 1: Write URL helper tests**

Create `apps/cli/src/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildApiUrl } from './client';

describe('buildApiUrl', () => {
  it('joins base URL and API path without duplicate slashes', () => {
    expect(buildApiUrl('https://api.example.com/', '/api/docs/doc_1')).toBe('https://api.example.com/api/docs/doc_1');
  });
});
```

- [ ] **Step 2: Implement config loader**

Create `apps/cli/src/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  apiUrl: z.string().url(),
  token: z.string().min(1),
});

export type MarklabCliConfig = z.infer<typeof configSchema>;

export function configPath(home = process.env.HOME ?? process.cwd()): string {
  return join(home, '.marklab', 'config.json');
}

export function readConfig(path = configPath()): MarklabCliConfig {
  if (!existsSync(path)) throw new Error('marklab_config_not_found');
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeConfig(config: MarklabCliConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
```

- [ ] **Step 3: Implement API client**

Create `apps/cli/src/client.ts`:

```ts
export function buildApiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export class MarklabClient {
  constructor(private readonly apiUrl: string, private readonly token: string) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  async health() {
    const response = await fetch(buildApiUrl(this.apiUrl, '/healthz'), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`health_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async readDoc(docId: string, branchId: string) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/branches/${branchId}/read`), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`read_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async writeDoc(docId: string, branchId: string, input: { baseVersionId: string; baseHash: string; markdown: string }) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/branches/${branchId}/write`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`write_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async editDoc(docId: string, branchId: string, input: { observedVersionId?: string; oldString: string; newString: string; replaceAll?: boolean }) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/branches/${branchId}/edit`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`edit_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async listVersions(docId: string, branchId: string) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/branches/${branchId}/versions`), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`versions_list_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async showVersion(docId: string, versionId: string) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/versions/${versionId}`), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`version_show_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async importDoc(input: { title: string; markdown: string }) {
    const response = await fetch(buildApiUrl(this.apiUrl, '/api/docs/import'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`import_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async exportDoc(docId: string, branchId: string) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/branches/${branchId}/export.md`), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`export_doc_failed:${response.status}:${await response.text()}`);
    return {
      markdown: await response.text(),
      contentDisposition: response.headers.get('content-disposition'),
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/cli test
npx -y pnpm@10.0.0 --filter @marklab/cli typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/config.ts apps/cli/src/client.ts apps/cli/src/client.test.ts
git commit -m "feat: add marklab cli api client"
```

## Task 3: CLI commands

**Files:**
- Create: `apps/cli/src/commands.ts`
- Create: `apps/cli/src/index.ts`

- [ ] **Step 1: Implement command registration**

Create `apps/cli/src/commands.ts` with commands for config, health, read, write, edit, versions, export, and import.

Behavior requirements:

```text
read-doc --json:
  prints the read_doc JSON response

read-doc --out:
  writes canonical markdown directly to the requested path and prints version/hash JSON

edit-doc:
  sends one exact oldString/newString replacement
  optionally includes observedVersionId for audit context
  prints JSON with status "written", versionId, versionNumber, hash

write-doc --from:
  reads target Markdown from a file
  sends baseVersionId/baseHash plus full target Markdown
  prints JSON with status "written", versionId, versionNumber, hash

write-doc --stdin:
  reads target Markdown from stdin
  sends baseVersionId/baseHash plus full target Markdown
  prints JSON with status "written", versionId, versionNumber, hash
```

The CLI must not implement `accept`, `reject`, `submit-snapshot`, `snapshot create`, `preview-doc-change`, `apply-doc-change`, or `multi-edit-doc`.

- [ ] **Step 2: Implement entrypoint**

Create `apps/cli/src/index.ts`:

```ts
#!/usr/bin/env node
import { createProgram } from './commands';

await createProgram().parseAsync(process.argv);
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/cli typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/commands.ts apps/cli/src/index.ts
git commit -m "feat: add marklab cli commands"
```

## Task 4: MarkLab agent skill

**Files:**
- Create: `skills/marklab/SKILL.md`

- [ ] **Step 1: Create skill**

Create `skills/marklab/SKILL.md`:

```markdown
---
name: marklab
description: Use when reading or editing MarkLab cloud Markdown documents through the MarkLab CLI.
---

# MarkLab Agent Workflow

Use this skill whenever you need to read, edit, write, export, import, or inspect versions of a MarkLab document.

## Core Rule

MarkLab exposes simple online document tools. The model owns proposal explanation and review text; MarkLab owns deterministic execution and version history.

Use `marklab edit-doc` only for one small exact replacement:

```bash
marklab edit-doc --doc <docId> --branch <branchId> --old-string "Old text" --new-string "New text"
```

Use `marklab write-doc` for broad, multi-region, structural, destructive, high-stakes, or uncertain changes:

```bash
marklab read-doc --doc <docId> --branch <branchId> --json
marklab write-doc --doc <docId> --branch <branchId> --base-version <versionId> --base-hash <hash> --from <file.md>
```

Before `write-doc`, explain the proposed change in chat. For meaningful or high-stakes changes, include a concise diff or before/after excerpt.

## Forbidden Patterns

- Do not call `write-doc` without a fresh `read-doc` base version and hash.
- Do not use `edit-doc` for multiple independent changes or structural rewrites.
- Do not bypass stale version/hash errors.
- Do not retry the same `write-doc` body after `live_yjs_state_changed`; reread first and merge the latest human/live edits into a new target.
- Do not treat product export files as live source of truth.
- Do not require default local proposal snapshots, server-side change sets, or app-level accept/reject state.
```

- [ ] **Step 2: Verify skill wording**

Search the skill for removed workflow terms:

```bash
rg -n "multi_edit|multi-edit|snapshot create|proposal\\.md|submit-snapshot|change_set|preview_doc_change|apply_doc_change" skills/marklab/SKILL.md
```

Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add skills/marklab/SKILL.md
git commit -m "docs: add marklab agent skill"
```

## Later: MCP Adapter

MCP is useful after the CLI/skill workflow is stable because MCP-native clients can discover tools without custom shell commands. It should be a thin adapter over the same HTTP API or CLI and must not introduce a parallel approval, preview, or write policy.

When MCP is added, expose:

```text
read_doc
write_doc
edit_doc
list_versions
branch_from_version
export_doc
import_doc
```

MCP tool descriptions should point agents to the MarkLab skill workflow. MCP alone is not the policy layer.
