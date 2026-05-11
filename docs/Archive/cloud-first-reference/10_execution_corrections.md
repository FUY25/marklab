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

1. `docs/Archive/cloud-first-reference/02_milkdown_roundtrip_collab_spike_plan.md` seeds the Yjs XML fragment with `service.bindDoc(ydoc).applyTemplate(initialMarkdown).setAwareness(awareness).connect()` for browser-opened empty collaboration documents, but import and branch creation should no longer rely on first browser open. `docs/Archive/cloud-first-reference/04_import_export_plan.md` and `docs/Archive/cloud-first-reference/05_version_branch_plan.md` now require a Milkdown transformer to initialize Yjs state from Markdown/version snapshots, with a tested live-writer seed-if-empty fallback if needed.

2. `apps/web/package.json` now includes the direct peer/runtime packages required by `@milkdown/plugin-collab`: `y-prosemirror`, `y-protocols`, and `yjs`. The plan imports `Awareness` from `y-protocols/awareness`, so relying on transitive dependencies would fail under pnpm.

3. `docs/Archive/cloud-first-reference/03_realtime_backend_persistence_plan.md`, `docs/Archive/cloud-first-reference/05_version_branch_plan.md`, and `docs/Archive/cloud-first-reference/04_import_export_plan.md` no longer store empty byte buffers as Yjs updates. Empty bytes are not a valid encoded Yjs update. Truly blank documents may use a valid encoded empty Y.Doc update; import and branch-from-version must initialize Yjs state from Markdown through the Milkdown transformer or rely on the tested live-writer seed-if-empty fallback.

4. `docs/Archive/cloud-first-reference/03_realtime_backend_persistence_plan.md` no longer claims raw Hocuspocus persistence keeps the canonical Markdown mirror fresh. Human-edit mirror refresh is explicitly assigned to the Milkdown serialization path.

5. `docs/Archive/cloud-first-reference/06_ai_write_api_plan.md` no longer creates a mirror-only `applyMarkdownToBranchState` seam or allows whole-document live replacement as the MVP write path. The corrected contract requires a minimal transaction live writer that parses target canonical Markdown, compares it to the current Yjs-bound ProseMirror document, applies only changed ranges through transactions/Yjs updates, and derives mirror/hash/version after live state is updated.

6. `docs/Archive/cloud-first-reference/06_ai_write_api_plan.md` now validates both `baseVersionId` and `baseHash` for full writes and returns `versionId`, `versionNumber`, and `hash` for accepted writes/edits.

7. Plans that create/import/branch/version now use a checked-out Postgres client for transactions instead of repeated pool-level transaction calls.

8. `docs/Archive/cloud-first-reference/01_foundation_repo_plan.md` now creates root and package TypeScript configs before running package `typecheck`.

9. The environment has a broken Volta `pnpm` shim. Use `npx -y pnpm@10.0.0 ...` unless pnpm is installed into Volta first.

10. The initial schema plan now creates `agent_tokens` and `share_links`; routes for managing them are still separate feature work before MVP completion.

11. The web editor should migrate from the bare Milkdown wrapper to `@milkdown/crepe` for the human editing experience. Enable block editing, slash menu, floating toolbar, tables, CodeMirror code blocks, and LaTeX. Keep `Crepe.Feature.TopBar` disabled because the desired editing chrome is contextual, not a fixed top toolbar. Keep all editor lifecycle and collab wiring inside one wrapper component.

12. Do not add `@milkdown/plugin-highlight` to the editable Crepe editor. It is for code-block token decoration, while Crepe's CodeMirror feature already covers editable code blocks. Persistent prose highlighting is a separate future custom-mark feature.

13. In collaborative editing, Yjs/y-prosemirror undo is authoritative. Crepe's internal ProseMirror history plugin may remain installed, but its `Mod-z`, `Mod-y`, and `Shift-Mod-z` shortcuts must be disabled so `@milkdown/plugin-collab` owns undo/redo behavior.

14. Disable image insertion until upload/storage is designed. Do not persist blob URLs or base64 image payloads into branch Markdown/Yjs state.

15. `Crepe.Feature.AI` is intentionally excluded from the current execution. Revisit it after the human editor and live writer are stable, using its streaming and diff-review plugins as UI references rather than as a direct model/write path. Do not build AI streaming UX, selection-aware AI, or in-app AI diff UI for MVP.

16. AI review/diffing is primarily model/runtime behavior, not MarkLab product state. The MVP does not require in-app AI diff UI, server-side preview/change-set persistence, or default local proposal snapshots. Small exact changes use `edit_doc`; broader or riskier changes should be explained in chat before `write_doc`.

17. Plan 7 is now CLI + agent skill first, not MCP first. The public MVP write surface is `read_doc`, `edit_doc`, and `write_doc`; `multi_edit_doc`, `snapshot create`, `preview_doc_change`, `apply_doc_change`, and `change_sets` are not MVP public workflows. MCP can be added later as a thin adapter over the stable API/CLI workflow, but MCP is not the policy layer.

18. The canonical Markdown mirror must be derived from Milkdown serializer output plus deterministic formatting. Prettier-only canonicalization is not enough to be the semantic source of truth for import, export, versions, read_doc, or AI live writes.
19. Plan file numbering now matches the recommended execution order: `04_import_export`, `05_version_branch`, then `06_ai_write_api`. This avoids the earlier ambiguity where filenames implied AI routes could be implemented before import/export and version services existed.
20. `doc-read.ts` is now created in `docs/Archive/cloud-first-reference/04_import_export_plan.md` as a shared canonical branch read service. `docs/Archive/cloud-first-reference/06_ai_write_api_plan.md` uses that existing service instead of creating it later, so import/export does not depend on the AI plan.
21. `docs/Archive/cloud-first-reference/05_version_branch_plan.md` now includes version list/show and branch-from-version HTTP routes. This closes the gap where the CLI plan required `versions list/show` commands but no API route plan exposed those operations.
22. `LiveMarkdownWriter` imports in `docs/Archive/cloud-first-reference/06_ai_write_api_plan.md` now point at `services/live-writer`, where the type is defined, rather than `services/editor-state`.
23. `LiveMarkdownWriter.applyMarkdownTransaction()` must return a valid non-empty encoded `yjsState` with `serializedMarkdown`, and `applyMarkdownToBranchState()` must persist that Yjs state transactionally with the canonical mirror and immutable version snapshot. Empty or invalid writer state is a fail-closed `503 invalid_live_yjs_state`, not a mirror-only fallback.
24. Export must not produce a versioned filename unless the flushed mirror hash matches the branch head version hash. Normal dirty live state should be handled by the flush path creating or selecting a matching system version before export/read returns; `export_version_mismatch` is reserved for impossible or externally inconsistent post-flush state.
25. `docs/Archive/cloud-first-reference/06_2_live_writer_transformer_integration_plan.md` sits between Plan 6 and Plan 7. It converts the Plan 4/5/6 fail-closed seams into a real headless Milkdown transformer, concrete Postgres live writer, and read/export flush behavior. Plan 7 must not start until Plan 6.2's deployment gate passes.
26. Full-document `write_doc` must reject if the freshly serialized live Yjs Markdown hash differs from the submitted `baseHash`. Pre-agent checkpoint creation can preserve human work for accepted edits or fresh-base writes, but it must not silently bridge a stale full-document write over newer live human edits. Agents should handle `live_yjs_state_changed` by calling `read_doc` again and rebuilding the target from the latest document.
27. Plan 6.2's browser-visible API write smoke requires a real Web remote document route. That work is now explicitly owned by `docs/Archive/cloud-first-reference/06_3_web_remote_document_mode_plan.md`; Plan 7 CLI/skill work does not cover browser product E2E.
28. `docs/Archive/cloud-first-reference/06_4_web_document_lifecycle_ui_plan.md` owns Web create/import/open/export controls. Backend import/export routes alone are not enough for MVP product testing.
29. `docs/Archive/cloud-first-reference/06_5_web_version_branch_ui_plan.md` owns Web version history, branch switching, branch-from-version, and restore-as-new-version UI. Plan 5 only provides backend primitives.
30. `docs/Archive/cloud-first-reference/06_6_access_tokens_share_links_plan.md` owns document-scoped share links, agent token creation/revocation, controlled-MVP admin/bootstrap token, production auth mode, and Hocuspocus access checks. The initial schema tables are not sufficient for deployment without these routes and checks.
31. `docs/Archive/cloud-first-reference/08_1_deployment_hardening_plan.md` extends the baseline deployment plan with schema application, web image/config, readiness checks, smoke scripts, and runbook. `docs/Archive/cloud-first-reference/11_mvp_launch_readiness_plan.md` is the final cross-plan acceptance gate.
32. Plan 6.3 must flush active Hocuspocus in-memory Y.Doc state before REST read/write/edit/export boundaries. Browser edits that have converged over WebSocket but have not reached the normal persistence timer must still be visible to `read_doc`, stale-write checks, and export.

## Safe First Slice

The foundation utilities are independent of the Milkdown and persistence issues. Start there, with two adjustments:

- Add root and package `tsconfig.json` files during workspace setup.
- Use `npx -y pnpm@10.0.0` for install/test/typecheck in this environment.
