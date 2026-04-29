# MCP Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the cloud Markdown doc as MCP resources and tools so Claude Code/Codex-style agents can read, write, edit, export, and inspect versions.

**Architecture:** Wrap existing HTTP API with an MCP server. Do not invent new write semantics; MCP tools call the same read/write/edit/version/export endpoints.

> **Context note:** The original MCP plan goal mentioned export and versions, but the concrete schemas only covered read/write/edit. The corrected plan includes the full MVP tool surface from product requirements: `read_doc`, `write_doc`, `edit_doc`, `list_versions`, `branch_from_version`, and `export_doc`.

**Tech Stack:** Node.js, MCP SDK, Zod, existing REST API.

---

## File Structure

- Create: `apps/mcp/package.json` — MCP server package.
- Create: `apps/mcp/tsconfig.json` — MCP package TypeScript config.
- Create: `apps/mcp/src/client.ts` — API client wrapper.
- Create: `apps/mcp/src/tools.ts` — MCP tool definitions.
- Create: `apps/mcp/src/index.ts` — MCP entrypoint.
- Test: `apps/mcp/src/client.test.ts`.

## Scope Check

This plan creates agent access only. The app still does not provide in-app diff accept/reject; the agent environment owns that behavior.

### Task 1: MCP package setup

**Files:**
- Create: `apps/mcp/package.json`
- Create: `apps/mcp/tsconfig.json`

- [ ] **Step 1: Create MCP package**

Create `apps/mcp/package.json`:

```json
{
  "name": "@mdcollab/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create MCP TypeScript config**

Create `apps/mcp/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

> **Context note:** The original package script used `tsc --noEmit` without a package `tsconfig.json`. This config makes typechecking deterministic.

- [ ] **Step 3: Install dependencies**

Run:

```bash
pnpm install
```

Expected: install completes.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/package.json apps/mcp/tsconfig.json pnpm-lock.yaml
git commit -m "chore: add mcp package"
```

### Task 2: API client wrapper

**Files:**
- Create: `apps/mcp/src/client.ts`
- Test: `apps/mcp/src/client.test.ts`

- [ ] **Step 1: Write client URL test**

Create `apps/mcp/src/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildDocReadUrl } from './client';

describe('buildDocReadUrl', () => {
  it('builds read endpoint URL', () => {
    expect(buildDocReadUrl('https://api.example.com', 'doc_abc', 'br_main')).toBe('https://api.example.com/api/docs/doc_abc/branches/br_main/read');
  });
});
```

- [ ] **Step 2: Implement client URL helper and API calls**

Create `apps/mcp/src/client.ts`:

```ts
export function buildDocReadUrl(baseUrl: string, docId: string, branchId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/docs/${docId}/branches/${branchId}/read`;
}

export class MdCollabClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async readDoc(docId: string, branchId: string) {
    const response = await fetch(buildDocReadUrl(this.baseUrl, docId, branchId), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`read_doc_failed:${response.status}`);
    return response.json();
  }

  async writeDoc(docId: string, branchId: string, input: { baseVersionId: string; baseHash: string; markdown: string }) {
    const response = await fetch(`${this.baseUrl}/api/docs/${docId}/branches/${branchId}/write`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`write_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async editDoc(docId: string, branchId: string, input: { baseVersionId: string; oldString: string; newString: string; replaceAll?: boolean }) {
    const response = await fetch(`${this.baseUrl}/api/docs/${docId}/branches/${branchId}/edit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`edit_doc_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async listVersions(docId: string) {
    const response = await fetch(`${this.baseUrl}/api/docs/${docId}/versions`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`list_versions_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async branchFromVersion(docId: string, versionId: string, input: { name: string }) {
    const response = await fetch(`${this.baseUrl}/api/docs/${docId}/versions/${versionId}/branch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`branch_from_version_failed:${response.status}:${await response.text()}`);
    return response.json();
  }

  async exportDoc(docId: string, branchId: string) {
    const response = await fetch(`${this.baseUrl}/api/docs/${docId}/branches/${branchId}/export.md`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`export_doc_failed:${response.status}:${await response.text()}`);
    return response.text();
  }
}
```

> **Context note:** The original client stopped at read/write/edit. The corrected client includes version listing, branch creation, and export so the MCP package can expose all required agent tools without inventing separate semantics.

- [ ] **Step 3: Run test**

Run:

```bash
pnpm test apps/mcp/src/client.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/client.ts apps/mcp/src/client.test.ts
git commit -m "feat: add mcp api client"
```

### Task 3: Tool definitions

**Files:**
- Create: `apps/mcp/src/tools.ts`

- [ ] **Step 1: Create tool schemas**

Create `apps/mcp/src/tools.ts`:

```ts
import { z } from 'zod';

export const readDocSchema = z.object({
  docId: z.string(),
  branchId: z.string().default('main'),
});

export const writeDocSchema = z.object({
  docId: z.string(),
  branchId: z.string().default('main'),
  baseVersionId: z.string(),
  baseHash: z.string(),
  markdown: z.string(),
});

export const editDocSchema = z.object({
  docId: z.string(),
  branchId: z.string().default('main'),
  baseVersionId: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
});

export const listVersionsSchema = z.object({
  docId: z.string(),
});

export const branchFromVersionSchema = z.object({
  docId: z.string(),
  versionId: z.string(),
  name: z.string().min(1),
});

export const exportDocSchema = z.object({
  docId: z.string(),
  branchId: z.string().default('main'),
});
```

> **Context note:** These schemas align the MCP implementation with `01_product_requirements.md`, which requires `list_versions`, `branch_from_version`, and `export_doc` in addition to read/write/edit.

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/src/tools.ts
git commit -m "feat: add mcp tool schemas"
```
