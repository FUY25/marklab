# Canonical Markdown Contract

## Meaning of canonical Markdown

Canonical Markdown is the platform-standard Markdown representation of a document.

It is not a new language. It is a normalized Markdown format that the app uses for:

- AI reads.
- AI writes/edits.
- Version snapshots.
- Export files.
- Search/indexing.

## What the product guarantees

For supported Markdown features, the product guarantees semantic preservation:

```text
heading remains heading
paragraph remains paragraph
link remains link
table remains table
code fence remains code fence
Mermaid fence remains Mermaid fence
frontmatter remains frontmatter when enabled
```

The product does not guarantee byte-for-byte preservation of uploaded Markdown.

## Normalization examples

List markers may normalize:

```md
* item one
* item two
```

Export may become:

```md
- item one
- item two
```

Reference links may normalize:

```md
[OpenAI][1]

[1]: https://openai.com
```

Export may become:

```md
[OpenAI](https://openai.com)
```

Tables may normalize spacing:

```md
|A|B|
|-|-|
|1|2|
```

Export may become:

```md
| A | B |
| - | - |
| 1 | 2 |
```

This is acceptable if the semantic meaning remains stable and AI can read/write the canonical form.

## Supported syntax for MVP

Required:

- CommonMark headings, paragraphs, emphasis, strong, links, images.
- Ordered and unordered lists.
- Blockquotes.
- Fenced code blocks.
- GitHub-Flavored Markdown tables.
- Task lists.
- YAML frontmatter preservation.

Preferred if plugin support is stable:

- Mermaid as fenced code blocks.
- Math as inline/block syntax.
- Footnotes.

Not guaranteed in MVP:

- MDX.
- Arbitrary raw HTML round-trip.
- Obsidian wikilinks.
- Dataview syntax.
- Custom Markdown directives.
- Exact source formatting.

## Parser, serializer, and formatter contract

Canonical Markdown must be derived through Milkdown's Markdown/ProseMirror transformation pipeline.

Authoritative semantic path:

```text
Markdown input
  -> Milkdown parser with the active editor schema
  -> ProseMirror document
  -> Milkdown serializer
  -> Markdown output
  -> deterministic formatter
  -> canonical Markdown
```

For human edits, export, versions, and AI reads, the reverse path starts from the live editor state:

```text
Yjs/ProseMirror live doc
  -> Milkdown serializer
  -> deterministic formatter
  -> canonical Markdown
```

Suggested final formatter:

```text
Prettier markdown parser
```

Formatter options:

```json
{
  "parser": "markdown",
  "proseWrap": "preserve",
  "singleQuote": false
}
```

Rationale:

- Deterministic output helps AI `oldString` matching.
- Deterministic output reduces meaningless version diffs.
- `proseWrap: preserve` avoids aggressively rewrapping prose.

Prettier is not the semantic authority. It runs after Milkdown serialization to stabilize formatting. If Milkdown cannot parse or serialize a supported Markdown construct, the fix belongs in the Milkdown/plugin/schema configuration or fixture policy, not in ad hoc string rewriting.

## Import contract

On local `.md` upload:

1. Read raw Markdown.
2. Run syntax support checks.
3. Parse through Milkdown with the active editor schema.
4. Create the ProseMirror/Yjs branch state from that parsed document.
5. Serialize the resulting editor document back to Markdown.
6. Format to canonical Markdown.
7. Create version `v1` with operation `import`.
8. Store the encoded Yjs state and canonical mirror/hash together.

The import flow must not store a non-empty `current_markdown` beside an empty collaborative Yjs document as the final state. If a temporary MVP path cannot initialize Yjs at import time, the live writer must explicitly seed empty Yjs state from `current_markdown` before any AI write/edit.

## Export contract

On export:

1. Flush pending human edits through the Milkdown serializer path.
2. Use the resulting canonical Markdown mirror.
3. Ensure the exported body hash matches the version/hash used in the filename.
4. If the flushed mirror hash differs from the current branch head version hash, create or select a matching system version before returning the file.
5. Do not inject metadata into the body by default.
6. Use metadata-rich filename.

`export_version_mismatch` is a fail-closed response for impossible or externally inconsistent post-flush state. It should not be the normal result of a dirty but serializable human edit.

> **Current implementation note:** The matching-version flush path is a Plan 6.2 deliverable. Before Plan 6.2 is implemented, `flushBranchMarkdownMirror` may fail closed with `milkdown_transformer_not_configured`; tests may only exercise export mismatch behavior by mocking an already-flushed mirror state.

Filename format:

```text
{slug}__EXPORT__doc-{docIdShort}__branch-{branchSlug}__v{versionNumber}__{yyyyMMdd-HHmmssZ}__sha-{hash8}__check-cloud-before-use.md
```

## AI contract

AI always receives canonical Markdown and must send edits against canonical Markdown.

`read_doc` response:

```json
{
  "docId": "doc_abc",
  "branchId": "br_main",
  "versionId": "ver_043",
  "versionNumber": 43,
  "hash": "sha256:7b91a2cf...",
  "markdown": "# Strategy memo\n\n..."
}
```

Agent instruction:

```text
Treat exported local files as snapshots. Before using an exported file as current truth, call read_doc again and compare version/hash.
```
