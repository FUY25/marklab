# Execution Corrections From Milkdown Review

The Milkdown repository was cloned to `resource/milkdown` at commit `114b4b35`.
The current Milkdown source confirms these plan assumptions are valid:

- `@milkdown/kit` exists at version `7.20.0`.
- `@milkdown/react` exists at version `7.20.0`.
- `@milkdown/plugin-collab` exists at version `7.20.0`.
- `rootCtx`, `defaultValueCtx`, `collabServiceCtx`, `bindDoc`, `setAwareness`, and `connect` still exist.
- Milkdown exposes `getMarkdown` and `replaceAll` through `@milkdown/kit/utils`.

The following corrections should be applied while executing the plans.

## Corrections Applied To Plans

1. `plans/02_milkdown_roundtrip_collab_spike_plan.md` now seeds the Yjs XML fragment with `service.bindDoc(ydoc).applyTemplate(initialMarkdown).setAwareness(awareness).connect()` so an empty collaboration document receives imported Markdown before y-sync takes over.

2. `apps/web/package.json` now includes the direct peer/runtime packages required by `@milkdown/plugin-collab`: `y-prosemirror`, `y-protocols`, and `yjs`. The plan imports `Awareness` from `y-protocols/awareness`, so relying on transitive dependencies would fail under pnpm.

3. `plans/03_realtime_backend_persistence_plan.md`, `plans/05_version_branch_plan.md`, and `plans/06_import_export_plan.md` no longer store empty byte buffers as Yjs updates. Empty bytes are not a valid encoded Yjs update; the corrected plans use `createEmptyYjsState()` or treat a zero-length stored state as missing before calling `Y.applyUpdate`.

4. `plans/03_realtime_backend_persistence_plan.md` no longer claims raw Hocuspocus persistence keeps the canonical Markdown mirror fresh. Human-edit mirror refresh is explicitly assigned to the Milkdown serialization path.

5. `plans/04_ai_write_api_plan.md` no longer creates a mirror-only `applyMarkdownToBranchState` seam or allows whole-document live replacement as the MVP write path. The corrected contract requires a minimal transaction live writer that parses target canonical Markdown, compares it to the current Yjs-bound ProseMirror document, applies only changed ranges through transactions/Yjs updates, and derives mirror/hash/version after live state is updated.

6. `plans/04_ai_write_api_plan.md` now validates both `baseVersionId` and `baseHash` for full writes and returns `versionId`, `versionNumber`, and `hash` for accepted writes/edits.

7. Plans that create/import/branch/version now use a checked-out Postgres client for transactions instead of repeated pool-level transaction calls.

8. `plans/01_foundation_repo_plan.md` now creates root and package TypeScript configs before running package `typecheck`.

9. The environment has a broken Volta `pnpm` shim. Use `npx -y pnpm@10.0.0 ...` unless pnpm is installed into Volta first.

10. The initial schema plan now creates `agent_tokens` and `share_links`; routes for managing them are still separate feature work before MVP completion.

11. The web editor should migrate from the bare Milkdown wrapper to `@milkdown/crepe` for the human editing experience. Enable block editing, slash menu, floating toolbar, tables, CodeMirror code blocks, and LaTeX. Keep `Crepe.Feature.TopBar` disabled because the desired editing chrome is contextual, not a fixed top toolbar. Keep all editor lifecycle and collab wiring inside one wrapper component.

12. Do not add `@milkdown/plugin-highlight` to the editable Crepe editor. It is for code-block token decoration, while Crepe's CodeMirror feature already covers editable code blocks. Persistent prose highlighting is a separate future custom-mark feature.

13. In collaborative editing, Yjs/y-prosemirror undo is authoritative. Crepe's internal ProseMirror history plugin may remain installed, but its `Mod-z`, `Mod-y`, and `Shift-Mod-z` shortcuts must be disabled so `@milkdown/plugin-collab` owns undo/redo behavior.

14. Disable image insertion until upload/storage is designed. Do not persist blob URLs or base64 image payloads into branch Markdown/Yjs state.

15. `Crepe.Feature.AI` is intentionally excluded from the current execution. Revisit it after the human editor and live writer are stable, using its streaming and diff-review plugins as UI references rather than as a direct model/write path. Do not build AI streaming UX, selection-aware AI, or in-app AI diff UI for MVP.

16. AI review/diffing should happen through a local proposal snapshot, not through app UI. `marklab snapshot create` should write only `proposal.md` and `metadata.json`; it should not create `baseline.md`, `before.md`, or `after.md` by default. Codex/Claude Code owns the native local file-edit review loop.

17. Plan 7 is now CLI + agent skill first, not MCP first. The online submit must mirror the local native action: Edit -> `edit_doc`, MultiEdit -> `multi_edit_doc`, Write -> `write_doc`. MCP can be added later as a thin adapter over the stable API/CLI workflow, but MCP is not the policy layer.

## Safe First Slice

The foundation utilities are independent of the Milkdown and persistence issues. Start there, with two adjustments:

- Add root and package `tsconfig.json` files during workspace setup.
- Use `npx -y pnpm@10.0.0` for install/test/typecheck in this environment.
