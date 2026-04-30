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
- New branch/import Yjs state is a valid encoded update containing the imported/version Markdown in the Milkdown/Yjs document model, not an empty collaborative document beside a non-empty mirror.
- If MVP uses live-writer seed-if-empty as a fallback, tests prove the writer seeds from `current_markdown` before applying the target transaction.
- `write_doc` rejects stale base hash.
- `write_doc` rejects stale base version.
- `edit_doc` accepts unique old string even if base version is stale.
- `edit_doc` rejects ambiguous string.
- Branch from version creates isolated branch state.
- Human Milkdown edits refresh `current_markdown/current_hash` before an agent `read_doc`.
- Human mirror refresh uses Milkdown serializer output plus canonical formatting, not Prettier-only formatting of stale strings.
- AI write/edit updates live editor state before mirror/version persistence.
- AI write/edit uses the minimal transaction live writer and does not perform mirror-only or wholesale live-document replacement.
- Unit tests must prove `applyMarkdownToBranchState` persists the live writer's serialized Markdown, not the requested target Markdown, and performs no mirror/version writes when the live writer fails.
- HTTP e2e tests must prove stale full writes and unavailable live writers do not call or bypass the minimal transaction writer.
- CLI tests verify simple online command semantics: `read_doc` returns canonical Markdown, `edit_doc` submits one exact replacement, `write_doc` submits full target Markdown with base version/hash, and no default snapshot workflow is required.
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
- Use `marklab read_doc` to inspect current canonical Markdown.
- Use `marklab edit_doc` for one exact low-risk replacement and confirm the editor updates.
- Use `marklab write_doc` with base version/hash for a broader target Markdown change after reviewing the agent's chat summary/diff.
- Try stale full `write_doc` and confirm it is rejected.
- Branch from an old version and edit the branch.
- Confirm main branch content remains unchanged.
