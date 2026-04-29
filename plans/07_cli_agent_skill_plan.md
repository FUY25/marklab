# CLI and Agent Skill Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MarkLab CLI and MarkLab agent skill so Codex/Claude Code can read cloud docs, create local proposal snapshots, review native file diffs, and submit the same semantic write/edit action back to MarkLab.

**Architecture:** The CLI wraps the existing HTTP API and owns only local filesystem artifacts under `.marklab/snapshots`. The skill is the policy layer: it teaches agents that local snapshots are review instruments, that local native Edit/MultiEdit/Write actions must be mirrored by `edit_doc`/`multi_edit_doc`/`write_doc`, and that MCP is optional later.

**Tech Stack:** Node.js CLI, TypeScript, Commander, Zod, existing REST API, Markdown canonicalizer, Codex/Claude skill Markdown.

---

## File Structure

- Create: `apps/cli/package.json` - MarkLab CLI package.
- Create: `apps/cli/tsconfig.json` - CLI TypeScript config.
- Create: `apps/cli/src/config.ts` - local config and auth token loading.
- Create: `apps/cli/src/client.ts` - HTTP API wrapper.
- Create: `apps/cli/src/snapshot.ts` - local proposal snapshot writer.
- Create: `apps/cli/src/commands.ts` - command registration.
- Create: `apps/cli/src/index.ts` - CLI entrypoint.
- Test: `apps/cli/src/snapshot.test.ts`.
- Test: `apps/cli/src/client.test.ts`.
- Create: `skills/marklab/SKILL.md` - agent workflow skill.

## Scope Check

This plan replaces the previous MCP-first Plan 7. MCP is not on the MVP critical path. It can be added later as a thin adapter over the same API/CLI semantics after the CLI + skill workflow is proven.

The CLI must not own user-level accept/reject. Codex/Claude Code native local file review owns that loop. If the user rejects a local diff, the agent simply does not call `marklab write_doc`, `marklab edit_doc`, or `marklab multi_edit_doc`.

## CLI Command Surface

Required MVP commands:

```text
marklab config set-api-url <url>
marklab config set-token <token>
marklab health

marklab read_doc --doc <docId> --branch <branchId> [--out <path>] [--json]
marklab snapshot create --doc <docId> --branch <branchId> [--dir <path>]
marklab snapshot status --snapshot <dir>

marklab write_doc --snapshot <dir> --from <proposal.md>
marklab edit_doc --snapshot <dir> --old-string <text> --new-string <text> [--replace-all]
marklab multi_edit_doc --snapshot <dir> --ops <edits.json>

marklab versions list --doc <docId> [--branch <branchId>]
marklab versions show --doc <docId> --version <versionId>
marklab export_doc --doc <docId> --branch <branchId> --out <dir>
marklab import_doc --title <title> --from <file.md>
```

Later commands:

```text
marklab branch_from_version --doc <docId> --version <versionId> --name <name>
marklab restore_version --doc <docId> --branch <branchId> --version <versionId>
```

## Snapshot Contract

`marklab snapshot create` writes exactly:

```text
.marklab/snapshots/{slug}__SNAPSHOT__doc-{docIdShort}__branch-{branchIdOrSlug}__v{versionNumber}__ver-{versionId}__{yyyyMMdd-HHmmssZ}__sha-{hash8}/
  proposal.md
  metadata.json
```

It does not write `baseline.md`, `before.md`, or `after.md`.

`proposal.md` starts as the canonical Markdown returned by `read_doc`. Codex/Claude Code native file-edit review treats that initial file content as the local diff baseline.

`metadata.json`:

```json
{
  "docId": "doc_abc",
  "branchId": "br_main",
  "baseVersionId": "ver_043",
  "baseVersionNumber": 43,
  "baseHash": "sha256:7b91a2cf...",
  "createdAt": "2026-04-29T15:30:12Z",
  "proposalPath": "proposal.md",
  "snapshotRole": "proposal"
}
```

## Semantic Submit Rule

The action used locally is the action submitted online:

```text
Native local Edit of proposal.md:
  submit with marklab edit_doc using the same oldString/newString

Native local MultiEdit of proposal.md:
  submit with marklab multi_edit_doc using the same ordered edit operations

Native local Write of proposal.md:
  submit with marklab write_doc using proposal.md as the full target
```

Do not infer `edit_doc` from a whole-file diff as the default path. If the agent no longer has exact old/new operation data, submit as `write_doc` and rely on the backend minimal transaction live writer.

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
    "@marklab/markdown": "workspace:*",
    "@marklab/shared": "workspace:*",
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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

  async editDoc(docId: string, branchId: string, input: { baseVersionId: string; oldString: string; newString: string; replaceAll?: boolean }) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/branches/${branchId}/edit`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`edit_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async multiEditDoc(docId: string, branchId: string, input: { baseVersionId: string; edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }> }) {
    const response = await fetch(buildApiUrl(this.apiUrl, `/api/docs/${docId}/branches/${branchId}/multi-edit`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`multi_edit_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @marklab/cli test
pnpm --filter @marklab/cli typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/config.ts apps/cli/src/client.ts apps/cli/src/client.test.ts
git commit -m "feat: add marklab cli api client"
```

## Task 3: Proposal snapshot writer

**Files:**
- Create: `apps/cli/src/snapshot.ts`
- Test: `apps/cli/src/snapshot.test.ts`

- [ ] **Step 1: Write snapshot tests**

Create `apps/cli/src/snapshot.test.ts`:

```ts
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProposalSnapshot } from './snapshot';

describe('createProposalSnapshot', () => {
  it('writes proposal.md and metadata.json only', () => {
    const root = mkdtempSync(join(tmpdir(), 'marklab-snapshot-'));
    const result = createProposalSnapshot({
      rootDir: root,
      title: 'Strategy Memo',
      docId: 'doc_abcdef',
      branchId: 'br_main',
      branchSlug: 'main',
      versionId: 'ver_043',
      versionNumber: 43,
      hash: 'sha256:7b91a2cf0000',
      markdown: '# Strategy\n',
      now: new Date('2026-04-29T15:30:12Z'),
    });

    expect(readFileSync(join(result.snapshotDir, 'proposal.md'), 'utf8')).toBe('# Strategy\n');
    expect(existsSync(join(result.snapshotDir, 'metadata.json'))).toBe(true);
    expect(existsSync(join(result.snapshotDir, 'baseline.md'))).toBe(false);
    expect(existsSync(join(result.snapshotDir, 'before.md'))).toBe(false);
    expect(existsSync(join(result.snapshotDir, 'after.md'))).toBe(false);
  });
});
```

- [ ] **Step 2: Implement snapshot writer**

Create `apps/cli/src/snapshot.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortHash } from '@marklab/shared/src/hash';

export interface CreateProposalSnapshotInput {
  rootDir: string;
  title: string;
  docId: string;
  branchId: string;
  branchSlug: string;
  versionId: string;
  versionNumber: number;
  hash: string;
  markdown: string;
  now: Date;
}

export function slugifyTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

export function formatUtcCompact(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function createProposalSnapshot(input: CreateProposalSnapshotInput) {
  const snapshotName = [
    `${slugifyTitle(input.title)}__SNAPSHOT`,
    `doc-${input.docId.slice(0, 6)}`,
    `branch-${input.branchSlug || input.branchId}`,
    `v${String(input.versionNumber).padStart(4, '0')}`,
    `ver-${input.versionId}`,
    formatUtcCompact(input.now),
    `sha-${shortHash(input.hash)}`,
  ].join('__');

  const snapshotDir = join(input.rootDir, '.marklab', 'snapshots', snapshotName);
  mkdirSync(snapshotDir, { recursive: true });

  writeFileSync(join(snapshotDir, 'proposal.md'), input.markdown);
  writeFileSync(
    join(snapshotDir, 'metadata.json'),
    `${JSON.stringify(
      {
        docId: input.docId,
        branchId: input.branchId,
        baseVersionId: input.versionId,
        baseVersionNumber: input.versionNumber,
        baseHash: input.hash,
        createdAt: input.now.toISOString(),
        proposalPath: 'proposal.md',
        snapshotRole: 'proposal',
      },
      null,
      2,
    )}\n`,
  );

  return { snapshotDir };
}
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @marklab/cli test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/snapshot.ts apps/cli/src/snapshot.test.ts
git commit -m "feat: add proposal snapshot writer"
```

## Task 4: CLI commands

**Files:**
- Create: `apps/cli/src/commands.ts`
- Create: `apps/cli/src/index.ts`

- [ ] **Step 1: Implement command registration**

Create `apps/cli/src/commands.ts` with commands for config, health, read, snapshot, write, edit, multi-edit, versions, export, and import. Each write/edit command must read `metadata.json` from `--snapshot`, then call the matching API method with `baseVersionId` and `baseHash` from metadata.

Behavior requirements:

```text
read_doc --out:
  writes canonical markdown directly to the requested path

snapshot create:
  calls read_doc
  writes proposal.md and metadata.json only
  prints JSON containing snapshotDir and proposalPath

write_doc:
  reads proposal.md
  calls write_doc with baseVersionId/baseHash from metadata
  prints JSON with status "written", versionId, versionNumber, hash

edit_doc:
  calls edit_doc with the exact oldString/newString provided by the agent
  prints JSON with status "written", versionId, versionNumber, hash

multi_edit_doc:
  reads ordered edits from JSON
  calls multi_edit_doc once
  prints JSON with status "written", versionId, versionNumber, hash
```

The CLI must not implement `accept`, `reject`, or `submit-snapshot`.

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
pnpm --filter @marklab/cli typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/commands.ts apps/cli/src/index.ts
git commit -m "feat: add marklab cli commands"
```

## Task 5: MarkLab agent skill

**Files:**
- Create: `skills/marklab/SKILL.md`

- [ ] **Step 1: Create skill**

Create `skills/marklab/SKILL.md`:

```markdown
---
name: marklab
description: Use when editing MarkLab cloud Markdown documents through the MarkLab CLI. Enforces local proposal review before online write/edit.
---

# MarkLab Agent Workflow

Use this skill whenever you need to read, edit, write, export, import, or inspect versions of a MarkLab document.

## Core Rule

Local review happens in `proposal.md`. Online submission must mirror the local native action:

- Native local Edit -> `marklab edit_doc` with the same `oldString` and `newString`.
- Native local MultiEdit -> `marklab multi_edit_doc` with the same ordered operations.
- Native local Write -> `marklab write_doc --from proposal.md`.

Do not infer `edit_doc` from a whole-file diff as the default path. If you no longer have exact old/new operation data, use `write_doc`.

## Standard Flow

1. Run `marklab snapshot create --doc <docId> --branch <branchId>`.
2. Edit the generated `proposal.md` using native file Edit, MultiEdit, or Write.
3. Let the user review the native Codex/Claude Code diff.
4. If the user rejects the diff, do not call any MarkLab write/edit command.
5. If the user accepts an Edit-style change, call `marklab edit_doc` with the same exact old/new strings.
6. If the user accepts multiple exact edits, call `marklab multi_edit_doc` with the same ordered operations.
7. If the user accepts a full rewrite, call `marklab write_doc --snapshot <dir> --from <proposal.md>`.
8. If the server returns stale, create a fresh snapshot and reapply the intended change.
9. Report the returned `versionId`, `versionNumber`, and `hash`.

## Forbidden Patterns

- Do not call online write/edit before local native diff review.
- Do not create or rely on `baseline.md`, `before.md`, or `after.md` in the snapshot directory.
- Do not treat product export files as live source of truth.
- Do not bypass stale version/hash errors.
- Do not use shell redirection or sed to mutate `proposal.md` when native file-edit tools are available.
```

- [ ] **Step 2: Verify skill wording**

Search the skill for forbidden old workflow terms:

```bash
rg -n "baseline|before\\.md|after\\.md|accepted|rejected|submit-snapshot" skills/marklab/SKILL.md
```

Expected: no matches except in the explicit forbidden-pattern explanations.

- [ ] **Step 3: Commit**

```bash
git add skills/marklab/SKILL.md
git commit -m "docs: add marklab agent skill"
```

## Later: MCP Adapter

MCP is useful after the CLI/skill workflow is stable because MCP-native clients can discover tools without custom shell commands. It should be a thin adapter over the same HTTP API or CLI and must not introduce a parallel approval or write policy.

When MCP is added, expose:

```text
read_doc
write_doc
edit_doc
multi_edit_doc
list_versions
branch_from_version
export_doc
import_doc
```

MCP tool descriptions should point agents to the MarkLab skill workflow for local proposal review. MCP alone is not the policy layer.
