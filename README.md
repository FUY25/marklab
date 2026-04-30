# MarkLab MVP Spec — Milkdown-first Revision

This package freezes the current MVP direction after the editor decision changed to **Milkdown-first**.

## One-line product definition

A cloud Markdown document where humans collaborate in a polished WYSIWYG editor while AI agents read and write the same document through canonical raw Markdown, with safe writes, automatic version snapshots, branchable history, rollback, and export to local `.md` files.

## Frozen MVP decisions

- **Editor:** Milkdown-first. Human UI is a WYSIWYG Markdown editor powered by Milkdown/ProseMirror/Yjs.
- **AI interface:** AI reads and writes canonical Markdown, not ProseMirror JSON.
- **Write tools:** Match Claude Code’s core mental model: `read`, guarded full-document `write`, and exact-string `edit`. No separate `insert` or public `multi_edit` tool in MVP; insertion is expressed as `edit(oldString, newString)` when it is a single exact replacement, while multi-region changes use `write`.
- **Source/Split:** Not required as editable modes in MVP. A read-only Markdown preview/debug panel may exist. Do not build two simultaneously editable editors over different document models.
- **Local sync:** Not in MVP. Local files are import/export artifacts only.
- **Export metadata:** Put metadata in the filename, not in the Markdown body by default.
- **AI review:** Done by the model and agent runtime before tool invocation. Small low-risk exact edits can call `edit`; meaningful or broad changes should be explained in chat before guarded `write`. MarkLab does not need server-side preview/change-set persistence or default local proposal snapshots in MVP.
- **Agent integration:** CLI + MarkLab skill first. MCP is optional later and should wrap the stable workflow rather than define it.
- **Version history:** Back end stores a version DAG/branch model. Front end starts with a simple branch/history UI.
- **Deployment:** Needs a persistent WebSocket-capable backend. Cloudflare is optional infrastructure, not the core product host.

## Files in this package

- `00_scope_and_decisions.md` — final product decisions and exclusions.
- `01_product_requirements.md` — MVP user journeys and functional requirements.
- `02_architecture_milkdown_first.md` — Milkdown/Yjs/Hocuspocus architecture.
- `03_canonical_markdown_contract.md` — canonical Markdown, formatter, import/export rules.
- `04_data_model_and_api.md` — database model and API contracts.
- `05_ai_write_versioning_branching.md` — safe write/edit semantics and version DAG.
- `06_testing_strategy.md` — tests, fixtures, and acceptance criteria.
- `07_risks_and_attention.md` — engineering risks and mitigation.
- `08_references.md` — sources and public docs used.
- `plans/` — implementation plans split by subsystem.
- `fixtures/` — Markdown fixture suite for round-trip and export tests.
- `resource/milkdown/` — local Milkdown source clone used to verify current editor/collab APIs.

## Plan corrections

The first pass of the plans was reviewed against the local Milkdown clone and current package metadata. Corrections are recorded inline near each affected section and summarized in `plans/10_execution_corrections.md`.

Key correction themes:

- Seed collaborative Milkdown documents through the Milkdown/Yjs document model instead of assuming `defaultValueCtx` or a Markdown mirror initializes shared state.
- Treat Milkdown parser/serializer output as the semantic authority for import, export, mirror refresh, version snapshots, and AI live writes. Prettier remains a final formatting stabilizer, not the source of truth.
- Never update `current_markdown/current_hash` without updating live Yjs/ProseMirror state first.
- Store valid encoded Yjs updates, not empty byte buffers.
- Use one checked-out Postgres client per transaction.
- Include the MVP storage for agent tokens and share links in the initial schema.

## Recommended implementation order

1. Foundation repo and shared types.
2. Milkdown round-trip/collab spike.
3. Hocuspocus persistence and editor shell.
4. Canonical Markdown import/export.
5. Version DAG service and branch primitives.
6. AI read/write/edit API using the live-state writer and version service.
7. MarkLab CLI + agent skill integration.
8. Deployment hardening.

MCP can be added after the CLI/skill workflow is proven. It should be a thin adapter over the same API/CLI semantics.

This order keeps each subsystem testable on its own. Do not start with GitHub sync, local watch sync, or complex permissions.

> **Context note:** The original order placed the AI API before versioning. The corrected AI API creates immutable versions on every accepted write/edit, so the version service must exist before the write/edit routes are completed.
