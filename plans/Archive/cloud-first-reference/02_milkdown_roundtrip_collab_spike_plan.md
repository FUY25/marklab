# Milkdown Round-trip and Collaboration Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **2026-04-29 update:** The original bare Milkdown wrapper is superseded by the Crepe collaborative editor migration below. Keep the original spike context for provenance, but new execution should use the "Crepe Human Editing Migration" section before treating Plan 2 as complete.

**Goal:** Prove Milkdown can render, collaborate, serialize to canonical Markdown, and accept API-originated Markdown updates, while exposing the polished Crepe human-editing experience.

**Architecture:** Build a minimal web app page with Milkdown, Yjs, and a Hocuspocus-compatible provider. Run fixture round-trip tests before committing Milkdown as production editor.

**Tech Stack:** React, Vite or Next.js, Milkdown, ProseMirror, Yjs, Hocuspocus provider, Vitest, Playwright.

---

## File Structure

- Create: `apps/web/package.json` — web dependencies.
- Create: `apps/web/tsconfig.json` — web TypeScript config.
- Create: `apps/web/src/components/MilkdownEditor.tsx` — Milkdown visual editor wrapper.
- Create: `apps/web/src/lib/editor-collab.ts` — Yjs provider creation.
- Create: `packages/markdown/package.json` — canonical Markdown package.
- Create: `packages/markdown/tsconfig.json` — markdown package TypeScript config.
- Create: `packages/markdown/src/canonicalize.ts` — final Markdown formatter used after Milkdown serialization.
- Create: `packages/markdown/src/fixtures.ts` — fixture loader helper.
- Test: `packages/markdown/src/canonicalize.test.ts`.
- Test: `apps/web/tests/milkdown-collab.spec.ts`.

## Scope Check

This plan is a spike but still produces working software: a visual collaborative editor page and repeatable round-trip tests. API write/versioning is handled in later plans.

## 2026-04-29 Decisions

- Use `@milkdown/crepe` for human editing instead of a bare `Editor.make().use(commonmark).use(gfm)` wrapper.
- Keep editor lifecycle in one React wrapper: creation, feature config, Yjs binding, awareness, listener wiring, readonly state, and cleanup must not spread into page components.
- Enable Crepe human editing features: `BlockEdit`, floating `Toolbar`, `LinkTooltip`, `ListItem`, `Cursor`, `Placeholder`, `Table`, `CodeMirror`, and `Latex`.
- Keep `Crepe.Feature.TopBar` disabled. The desired editing chrome is block handles, slash menu, and floating toolbar, not a fixed top toolbar.
- Do not enable Crepe AI in this plan. The installed `@milkdown/crepe@7.20.0` feature enum does not expose `AI`; if a later Crepe version adds it, keep it disabled until the human editor and live-writer path are stable.
- Disable `ImageBlock` until the product has a durable upload/storage URL policy. Do not allow blob URLs or base64 image payloads into persisted Markdown/Yjs state.
- Do not add `@milkdown/plugin-highlight` for the editable Crepe editor. `Crepe.Feature.CodeMirror` covers editable code-block highlighting. Persistent text highlighting is a future custom mark feature, not `plugin-highlight`.
- Treat Yjs/collab undo as authoritative. Do not expose ProseMirror history semantics in collaborative editing. Disable Milkdown history shortcuts so `@milkdown/plugin-collab` / `y-prosemirror` handles `Mod-z`, `Mod-y`, and `Shift-Mod-z`.
- Treat Milkdown parser/serializer output as the semantic authority for canonical Markdown. The Prettier formatter package only stabilizes serialized Markdown formatting; it is not a replacement for Milkdown round-trip tests.
- Add Playwright coverage for hidden TopBar, block menu, floating toolbar, code/table/math insertion, image entry absence, and collab undo behavior.

## Crepe Human Editing Migration

### Task A: Add Crepe dependency and CSS

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add `@milkdown/crepe` to the web package**

Run:

```bash
npx --yes pnpm@10.0.0 --filter @marklab/web add @milkdown/crepe@^7.20.0
```

Expected: `apps/web/package.json` and `pnpm-lock.yaml` include `@milkdown/crepe`.

- [ ] **Step 2: Import Crepe theme CSS**

Modify `apps/web/src/main.tsx` so Crepe common styles and the frame theme load before local application styles:

```ts
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './styles.css';
```

- [ ] **Step 3: Keep app styling as a quiet document workspace**

Update `apps/web/src/styles.css` to avoid card-heavy decorative UI and reserve visual weight for the editor itself. The editor root should support Crepe top bar, block handles, slash menus, floating toolbar, tables, code blocks, and math without clipping overlays.

### Task B: Replace bare Milkdown wrapper with collaborative Crepe wrapper

**Files:**
- Modify: `apps/web/src/components/MilkdownEditor.tsx`

- [ ] **Step 1: Construct `Crepe` in the wrapper**

Use `new Crepe({ root, defaultValue, features, featureConfigs })`.

Required feature settings:

```ts
features: {
  [Crepe.Feature.TopBar]: false,
  [Crepe.Feature.ImageBlock]: false,
}
```

- [ ] **Step 2: Disable ProseMirror history keyboard shortcuts**

Before `create()`, configure `historyKeymap.key`:

```ts
ctx.set(historyKeymap.key, {
  Undo: { shortcuts: [] },
  Redo: { shortcuts: [] },
});
```

This keeps Crepe's internal history plugin from handling `Mod-z/y`; collab's Yjs keymap should own those shortcuts after `connect()`.

- [ ] **Step 3: Bind collaboration after creation**

After `await crepe.create()`, call:

```ts
crepe.editor.action((ctx) => {
  ctx.get(collabServiceCtx)
    .bindDoc(ydoc)
    .applyTemplate(initialMarkdown)
    .setAwareness(awareness)
    .connect();
});
```

- [ ] **Step 4: Register listener callbacks inside the wrapper**

Use `crepe.on((listener) => listener.markdownUpdated(...))` to expose optional `onMarkdownChange` without making page components know about Milkdown internals.

### Task C: Add collab/undo debug surface for Playwright

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Keep the normal one-editor route**

The default `/` route should still render one production-like collaborative editor shell.

- [ ] **Step 2: Add a query-param test route**

When `?collab=two` is present, render two editor wrappers connected by bridged Yjs docs in memory. Use separate `Y.Doc` and `Awareness` instances for each editor, and mirror document updates with `Y.applyUpdate(peerDoc, update, 'remote-test-bridge')` so remote edits do not share the local `ySyncPluginKey` origin.

### Task D: Expand Playwright tests

**Files:**
- Modify: `apps/web/tests/milkdown-collab.spec.ts`

- [ ] **Step 1: Assert Crepe UI loads**

Verify `.milkdown`, `.ProseMirror`, and `.milkdown-toolbar`/block edit surfaces are available, and verify `.milkdown-top-bar` is absent.

- [ ] **Step 2: Assert text formatting works**

Select text, use the floating toolbar or keyboard shortcut, and verify bold/italic changes render.

- [ ] **Step 3: Assert slash menu and block insertion work**

Type `/`, verify the Crepe block menu appears, insert at least one structured block such as a table or code block, and verify it renders.

- [ ] **Step 4: Assert image entry is unavailable**

Open slash menu and verify image insertion is not present while image persistence is intentionally deferred.

- [ ] **Step 5: Assert collab undo keeps remote content**

In `?collab=two`, type local content in editor A and remote content in editor B. Focus editor A, press `Mod-z`, and verify A's content is undone while B's remote content remains synchronized.

### Task E: Verification

Run:

```bash
npx --yes pnpm@10.0.0 install --frozen-lockfile
npx --yes pnpm@10.0.0 typecheck
npx --yes pnpm@10.0.0 test
npx --yes pnpm@10.0.0 --filter @marklab/web test:e2e
npx --yes pnpm@10.0.0 --filter @marklab/web build
```

Then use Playwright CLI for an interactive smoke pass:

```bash
command -v npx >/dev/null 2>&1
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
"$PWCLI" open http://127.0.0.1:5175 --headed
"$PWCLI" snapshot
```

### Task 1: Canonical Markdown final formatter package

**Files:**
- Create: `packages/markdown/package.json`
- Create: `packages/markdown/tsconfig.json`
- Create: `packages/markdown/src/canonicalize.ts`
- Test: `packages/markdown/src/canonicalize.test.ts`

- [ ] **Step 1: Create markdown package**

Create `packages/markdown/package.json`:

```json
{
  "name": "@marklab/markdown",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "prettier": "^3.3.0"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Write failing canonicalize test**

Create `packages/markdown/src/canonicalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from './canonicalize';

describe('canonicalizeMarkdown', () => {
  it('keeps table content and stabilizes formatting', async () => {
    const input = '# Table\n\n|A|B|\n|-|-|\n|1|2|\n';
    const output = await canonicalizeMarkdown(input);
    expect(output).toContain('| A   | B   |');
    expect(output).toContain('| 1   | 2   |');
  });

  it('preserves fenced code blocks', async () => {
    const input = '```mermaid\ngraph TD\n  A-->B\n```\n';
    const output = await canonicalizeMarkdown(input);
    expect(output).toContain('```mermaid');
    expect(output).toContain('graph TD');
  });
});
```

> **Context note:** The original expected table output used compact `| A | B |` spacing. Prettier aligns table columns, so the corrected test checks the actual final formatter behavior while still asserting content preservation.
>
> This package is not the semantic Markdown authority. It only stabilizes Markdown that has already passed through Milkdown parser/serializer. The Milkdown transformer in `plans/04_import_export_plan.md` owns Markdown-to-editor and editor-to-Markdown semantic round-trip behavior.

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
pnpm test packages/markdown/src/canonicalize.test.ts
```

Expected: FAIL with module not found for `./canonicalize`.

- [ ] **Step 4: Implement canonicalizer**

Create `packages/markdown/src/canonicalize.ts`:

```ts
import { format } from 'prettier';

export async function canonicalizeMarkdown(markdown: string): Promise<string> {
  const formatted = await format(markdown, {
    parser: 'markdown',
    proseWrap: 'preserve',
    singleQuote: false,
  });

  return formatted.replace(/\s+$/u, '\n');
}
```

- [ ] **Step 5: Create markdown package TypeScript config**

Create `packages/markdown/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

> **Context note:** The original package relied on root TypeScript configuration only. Adding a package config makes `tsc --noEmit -p packages/markdown/tsconfig.json` deterministic and keeps package tests in scope.

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
pnpm test packages/markdown/src/canonicalize.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/markdown/package.json packages/markdown/tsconfig.json packages/markdown/src/canonicalize.ts packages/markdown/src/canonicalize.test.ts
git commit -m "feat: add canonical markdown final formatter"
```

### Task 2: Milkdown editor wrapper

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/src/components/MilkdownEditor.tsx`

- [ ] **Step 1: Create web package**

Create `apps/web/package.json`:

```json
{
  "name": "@marklab/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@hocuspocus/provider": "^4.0.0",
    "@milkdown/kit": "^7.0.0",
    "@milkdown/plugin-collab": "^7.0.0",
    "@milkdown/react": "^7.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "vite": "^6.0.0",
    "y-prosemirror": "^1.2.15",
    "y-protocols": "^1.0.6",
    "yjs": "^13.6.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.50.0",
    "typescript": "^5.8.0"
  }
}
```

> **Context note:** The original dependency list relied on transitive collaboration peer packages and called `pnpm --filter @marklab/web typecheck` without defining a `typecheck` script. pnpm does not guarantee transitive peer availability, so the corrected plan declares `y-prosemirror`, `y-protocols`, and `yjs` directly and adds the script the later step runs. Hocuspocus is set to the current major (`4.x`) observed on 2026-04-29; typecheck must lock any API adjustments.

- [ ] **Step 2: Create web TypeScript config**

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"]
}
```

> **Context note:** The original plan invoked the web typecheck without creating a web TypeScript project. This config gives React, DOM, and Vite types to the Milkdown wrapper and Playwright tests.

- [ ] **Step 3: Implement Milkdown editor wrapper**

Create `apps/web/src/components/MilkdownEditor.tsx`:

```tsx
import React, { useEffect, useRef } from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import type { Doc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export interface MilkdownEditorProps {
  initialMarkdown: string;
  ydoc: Doc;
  awareness: Awareness;
}

export function MilkdownEditor({ initialMarkdown, ydoc, awareness }: MilkdownEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) return;

    let disposed = false;
    let editor: Editor | undefined;

    async function createEditor() {
      editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, rootRef.current!);
          ctx.set(defaultValueCtx, initialMarkdown);
        })
        .use(commonmark)
        .use(gfm)
        .use(collab)
        .create();

      if (disposed) {
        editor.destroy();
        return;
      }

      editor.action((ctx) => {
        const service = ctx.get(collabServiceCtx);
        service.bindDoc(ydoc).applyTemplate(initialMarkdown).setAwareness(awareness).connect();
      });
    }

    void createEditor();

    return () => {
      disposed = true;
      editor?.destroy();
    };
  }, [awareness, initialMarkdown, ydoc]);

  return <div ref={rootRef} className="milkdown-editor" data-testid="milkdown-editor" />;
}
```

> **Context note:** The original wrapper set `defaultValueCtx` and then connected y-sync directly. In Milkdown `7.20.0`, collaborative state lives in the Yjs `prosemirror` XML fragment; `defaultValueCtx` alone does not seed an empty shared document after y-sync takes control. `applyTemplate(initialMarkdown)` copies the initial Markdown into the Yjs fragment only when the shared document is empty.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm --filter @marklab/web typecheck
```

Expected: PASS against the installed Milkdown and Hocuspocus versions. Do not use `any` casts around editor/collab setup; if package API names differ, update imports from the cloned Milkdown source and rerun typecheck until it passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/src/components/MilkdownEditor.tsx
git commit -m "feat: add milkdown collaborative editor wrapper"
```

### Task 3: Collaboration provider helper

**Files:**
- Create: `apps/web/src/lib/editor-collab.ts`

- [ ] **Step 1: Create collab provider helper**

Create `apps/web/src/lib/editor-collab.ts`:

```ts
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

export interface CreateEditorCollabInput {
  websocketUrl: string;
  roomName: string;
  token: string;
  user: {
    name: string;
    color: string;
  };
}

export function createEditorCollab(input: CreateEditorCollabInput) {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: input.websocketUrl,
    name: input.roomName,
    document: ydoc,
    token: input.token,
  });

  provider.awareness.setLocalStateField('user', input.user);

  return {
    ydoc,
    provider,
    awareness: provider.awareness,
    destroy: () => {
      provider.destroy();
      ydoc.destroy();
    },
  };
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/editor-collab.ts
git commit -m "feat: add hocuspocus provider helper"
```

### Task 4: Fixture round-trip test harness

**Files:**
- Create: `packages/markdown/src/fixtures.ts`
- Test: `packages/markdown/src/roundtrip-fixtures.test.ts`

- [ ] **Step 1: Create fixture loader**

Create `packages/markdown/src/fixtures.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const fixtureNames = [
  '01_basic.md',
  '02_table.md',
  '03_code_mermaid_frontmatter.md',
  '04_math_links_images.md',
] as const;

export async function readFixture(name: (typeof fixtureNames)[number]): Promise<string> {
  return readFile(join(process.cwd(), 'fixtures', name), 'utf8');
}
```

- [ ] **Step 2: Write fixture final-format stability test**

Create `packages/markdown/src/roundtrip-fixtures.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from './canonicalize';
import { fixtureNames, readFixture } from './fixtures';

describe('Markdown fixtures are final-format-stable', () => {
  for (const fixtureName of fixtureNames) {
    it(`${fixtureName} is stable after repeated final formatting`, async () => {
      const raw = await readFixture(fixtureName);
      const once = await canonicalizeMarkdown(raw);
      const twice = await canonicalizeMarkdown(once);
      expect(twice).toBe(once);
    });
  }
});
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm test packages/markdown/src/roundtrip-fixtures.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/markdown/src/fixtures.ts packages/markdown/src/roundtrip-fixtures.test.ts
git commit -m "test: add markdown fixture final-format checks"
```
