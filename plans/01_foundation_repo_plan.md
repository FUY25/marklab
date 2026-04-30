# Foundation Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the TypeScript monorepo, shared types, hashing/edit utilities, and test harness used by all later work.

**Architecture:** Use a small pnpm workspace with `apps/api`, `apps/web`, `packages/shared`, and `packages/markdown`. Start with pure utility tests before adding editor or database code.

**Tech Stack:** pnpm, TypeScript, Vitest, Zod, Node.js 22.

---

## File Structure

- Create: `package.json` — root scripts and workspace commands.
- Create: `pnpm-workspace.yaml` — workspace package locations.
- Create: `tsconfig.base.json` — shared TypeScript config.
- Create: `tsconfig.json` — root TypeScript project placeholder.
- Create: `vitest.config.ts` — root Vitest config.
- Create: `packages/shared/package.json` — shared utility package.
- Create: `packages/shared/tsconfig.json` — shared package TypeScript config.
- Create: `packages/shared/src/hash.ts` — SHA-256 hashing.
- Create: `packages/shared/src/edit-ops.ts` — Claude-like `oldString`/`newString` edit helpers.
- Create: `packages/shared/src/export-filename.ts` — metadata-rich export filename builder.
- Test: `packages/shared/src/hash.test.ts`.
- Test: `packages/shared/src/edit-ops.test.ts`.
- Test: `packages/shared/src/export-filename.test.ts`.

## Scope Check

This plan only establishes the repo and pure shared utilities. Editor, API, persistence, and versioning are separate implementation plans.

### Task 1: Root workspace setup

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create root package file**

Create `package.json`:

```json
{
  "name": "marklab",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p packages/shared/tsconfig.json",
    "lint": "eslint ."
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  },
  "packageManager": "pnpm@10.0.0"
}
```

> **Context note:** The original plan used `tsc -b` but did not create any referenced composite TypeScript projects. That would make the first `typecheck` unreliable. The corrected root script points at the package config created in this plan.

- [ ] **Step 2: Create workspace file**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create TypeScript base config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 4: Create root TypeScript project**

Create `tsconfig.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "files": []
}
```

> **Context note:** The root `tsconfig.json` is intentionally empty for now. Package configs own their source includes; the root file documents the shared base and gives future project references a stable anchor.

- [ ] **Step 5: Create Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
pnpm install
```

Expected: lockfile is created and no dependency resolution errors appear.

> **Local environment note:** If `pnpm` is unavailable or a Volta shim is broken, use `npx -y pnpm@10.0.0 install`. The plan keeps `pnpm` as the project package manager, but this workspace currently needs the `npx` form.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "chore: initialize pnpm typescript workspace"
```

### Task 2: Hash utility

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/hash.ts`
- Test: `packages/shared/src/hash.test.ts`

- [ ] **Step 1: Create shared package**

Create `packages/shared/package.json`:

```json
{
  "name": "@marklab/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {}
}
```

- [ ] **Step 2: Create shared package TypeScript config**

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

> **Context note:** The original package script used `tsc --noEmit` but no package `tsconfig.json` existed. This config keeps typechecking scoped to shared utilities and their tests.

- [ ] **Step 3: Write failing hash test**

Create `packages/shared/src/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sha256Hex, shortHash } from './hash';

describe('sha256Hex', () => {
  it('returns a stable sha256-prefixed hash', () => {
    expect(sha256Hex('hello')).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('shortHash', () => {
  it('returns the first eight hex chars after the prefix', () => {
    expect(shortHash('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')).toBe('2cf24dba');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run:

```bash
pnpm test packages/shared/src/hash.test.ts
```

Expected: FAIL with module not found for `./hash`.

- [ ] **Step 5: Implement hash utility**

Create `packages/shared/src/hash.ts`:

```ts
import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 8);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
pnpm test packages/shared/src/hash.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/package.json packages/shared/tsconfig.json packages/shared/src/hash.ts packages/shared/src/hash.test.ts
git commit -m "feat: add shared hash utilities"
```

### Task 3: Claude-like edit operations

**Files:**
- Create: `packages/shared/src/edit-ops.ts`
- Test: `packages/shared/src/edit-ops.test.ts`

- [ ] **Step 1: Write failing edit operation tests**

Create `packages/shared/src/edit-ops.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyStringEdit, findEditTarget } from './edit-ops';

describe('findEditTarget', () => {
  it('finds one target', () => {
    expect(findEditTarget('a b c', 'b', false)).toEqual({ kind: 'matched', indexes: [2] });
  });

  it('detects absent target', () => {
    expect(findEditTarget('a b c', 'x', false)).toEqual({ kind: 'not_found' });
  });

  it('detects ambiguity when replaceAll is false', () => {
    expect(findEditTarget('a b a', 'a', false)).toEqual({ kind: 'ambiguous', count: 2 });
  });
});

describe('applyStringEdit', () => {
  it('replaces a unique target', () => {
    expect(applyStringEdit('hello old world', 'old', 'new')).toBe('hello new world');
  });

  it('replaces all targets when replaceAll is true', () => {
    expect(applyStringEdit('old old', 'old', 'new', true)).toBe('new new');
  });

  it('throws on missing oldString', () => {
    expect(() => applyStringEdit('abc', 'xyz', 'x')).toThrow('old_string_not_found');
  });

  it('throws on ambiguous oldString', () => {
    expect(() => applyStringEdit('abc abc', 'abc', 'x')).toThrow('ambiguous_match');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test packages/shared/src/edit-ops.test.ts
```

Expected: FAIL with module not found for `./edit-ops`.

- [ ] **Step 3: Implement edit operations**

Create `packages/shared/src/edit-ops.ts`:

```ts
export type EditTargetResult =
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'matched'; indexes: number[] };

export function findEditTarget(markdown: string, oldString: string, replaceAll: boolean): EditTargetResult {
  if (oldString.length === 0) return { kind: 'not_found' };

  const indexes: number[] = [];
  let offset = 0;

  while (offset <= markdown.length) {
    const index = markdown.indexOf(oldString, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + oldString.length;
  }

  if (indexes.length === 0) return { kind: 'not_found' };
  if (!replaceAll && indexes.length > 1) return { kind: 'ambiguous', count: indexes.length };
  return { kind: 'matched', indexes };
}

export function applyStringEdit(markdown: string, oldString: string, newString: string, replaceAll = false): string {
  const target = findEditTarget(markdown, oldString, replaceAll);
  if (target.kind === 'not_found') throw new Error('old_string_not_found');
  if (target.kind === 'ambiguous') throw new Error('ambiguous_match');

  if (replaceAll) return markdown.split(oldString).join(newString);

  const index = target.indexes[0];
  if (index === undefined) throw new Error('old_string_not_found');
  return markdown.slice(0, index) + newString + markdown.slice(index + oldString.length);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test packages/shared/src/edit-ops.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/edit-ops.ts packages/shared/src/edit-ops.test.ts
git commit -m "feat: add claude-like markdown edit utility"
```

### Task 4: Export filename builder

**Files:**
- Create: `packages/shared/src/export-filename.ts`
- Test: `packages/shared/src/export-filename.test.ts`

- [ ] **Step 1: Write failing export filename test**

Create `packages/shared/src/export-filename.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildExportFilename } from './export-filename';

describe('buildExportFilename', () => {
  it('builds metadata-rich snapshot filename', () => {
    const name = buildExportFilename({
      title: 'Strategy Memo!',
      docId: 'doc_a13f9c999',
      branchSlug: 'main',
      versionNumber: 43,
      exportedAt: new Date('2026-04-29T15:30:12Z'),
      hash: 'sha256:7b91a2cf999999999',
    });

    expect(name).toBe('strategy-memo__EXPORT__doc-a13f9c__branch-main__v0043__20260429-153012Z__sha-7b91a2cf__check-cloud-before-use.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test packages/shared/src/export-filename.test.ts
```

Expected: FAIL with module not found for `./export-filename`.

- [ ] **Step 3: Implement export filename builder**

Create `packages/shared/src/export-filename.ts`:

```ts
export interface ExportFilenameInput {
  title: string;
  docId: string;
  branchSlug: string;
  versionNumber: number;
  exportedAt: Date;
  hash: string;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'untitled';
}

function formatUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function buildExportFilename(input: ExportFilenameInput): string {
  const slug = slugify(input.title);
  const docShort = input.docId.replace(/^doc_/, '').slice(0, 6);
  const version = String(input.versionNumber).padStart(4, '0');
  const hash8 = input.hash.replace(/^sha256:/, '').slice(0, 8);

  return `${slug}__EXPORT__doc-${docShort}__branch-${input.branchSlug}__v${version}__${formatUtc(input.exportedAt)}__sha-${hash8}__check-cloud-before-use.md`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test packages/shared/src/export-filename.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/export-filename.ts packages/shared/src/export-filename.test.ts
git commit -m "feat: add export snapshot filename builder"
```
