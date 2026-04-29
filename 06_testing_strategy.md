# Testing Strategy

## Test layers

### Unit tests

- Hashing.
- Edit target matching.
- Edit replacement.
- Export filename formatting.
- Version DAG operations.
- Canonical Markdown formatting.

### Integration tests

- Import Markdown creates doc, branch, Yjs state, mirror, and version.
- New branch/import Yjs state is a valid encoded update, not empty bytes.
- `write_doc` rejects stale base hash.
- `write_doc` rejects stale base version.
- `edit_doc` accepts unique old string even if base version is stale.
- `edit_doc` rejects ambiguous string.
- `multi_edit_doc` applies ordered replacements atomically and creates one version.
- `multi_edit_doc` rejects the entire operation if any replacement is absent or ambiguous.
- Branch from version creates isolated branch state.
- Human Milkdown edits refresh `current_markdown/current_hash` before an agent `read_doc`.
- AI write/edit updates live editor state before mirror/version persistence.
- AI write/edit uses the minimal transaction live writer and does not perform mirror-only or wholesale live-document replacement.
- Unit tests must prove `applyMarkdownToBranchState` persists the live writer's serialized Markdown, not the requested target Markdown, and performs no mirror/version writes when the live writer fails.
- HTTP e2e tests must prove stale full writes and unavailable live writers do not call or bypass the minimal transaction writer.
- Agent-side snapshot tests verify `snapshot create` writes only `proposal.md` and `metadata.json`, with no default `baseline.md`, `before.md`, or `after.md`.
- CLI tests verify native action semantics are preserved: Edit submits `edit_doc`, MultiEdit submits `multi_edit_doc`, and Write submits `write_doc`.
- Save-policy tests verify manual saves, autosave throttling, and pre-agent checkpoint creation when a dirty human mirror is not represented by the branch head version.

### Editor spike tests

- Milkdown parse/serialize round-trip against fixtures.
- Milkdown collaboration with two browser contexts.
- AI edit updates visual editor state.
- Minimal transaction writer applies changed ranges through ProseMirror transactions/Yjs updates.
- Human visual edit updates canonical mirror used by `read_doc`.
- Exported canonical Markdown remains usable after visual editing.

> **Context note:** The original test plan checked AI edits at the UI level but did not explicitly catch stale canonical mirrors after human edits or mirror-only AI writes. These tests protect the corrected architecture boundary between live collaboration state and canonical Markdown.

### End-to-end tests

Use Playwright:

1. User A opens doc.
2. User B opens same doc.
3. User A edits heading.
4. User B sees update.
5. Agent API edits paragraph.
6. Both users see updated paragraph.
7. Version list contains agent edit.
8. User branches from old version.
9. Main branch content remains unchanged.

## Required fixture suite

Run every fixture through:

```text
raw.md -> Milkdown parse/render -> serialize markdown -> formatter -> canonical.md
canonical.md -> Milkdown parse/render -> serialize -> formatter -> canonical2.md
```

Acceptance:

```text
canonical.md == canonical2.md
```

Semantic acceptance:

- No supported blocks disappear.
- Tables still render as tables.
- Code fences remain fenced.
- Frontmatter remains at top if enabled.

## Fixtures

See `fixtures/` in this package.

## Regression rule

When a Markdown fixture breaks, add the smallest possible fixture showing the failure before changing parser/formatter configuration.

## Load assumptions for MVP

- Single document under 100 KB should collaborate smoothly.
- Import/export docs under 200 KB should finish in less than 1 second server-side.
- Version snapshot storage can use full Markdown text initially.

## Manual QA checklist

- Upload a Markdown file with table, task list, and code fence.
- Confirm visual rendering.
- Export and compare with canonical Markdown fixture expectations.
- Use API to `edit_doc` a paragraph.
- Confirm visual editor updates without refresh.
- Run `marklab snapshot create` and confirm it creates `.marklab/snapshots/.../proposal.md` plus `metadata.json` only.
- Make a native local Edit to `proposal.md`, review the native agent diff, then submit the same `oldString/newString` with `marklab edit_doc`.
- Make a native local Write to `proposal.md`, review the native agent diff, then submit with `marklab write_doc`.
- Try stale full `write_doc` and confirm it is rejected.
- Branch from an old version and edit the branch.
- Confirm main branch content remains unchanged.
