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

## Formatter contract

Export and canonical mirror should use a deterministic formatter.

Suggested initial formatter:

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

- Deterministic output helps AI old_string matching.
- Deterministic output reduces meaningless version diffs.
- `proseWrap: preserve` avoids aggressively rewrapping prose.

## Import contract

On local `.md` upload:

1. Read raw Markdown.
2. Run syntax support checks.
3. Convert to Milkdown editor state.
4. Serialize back to Markdown.
5. Format to canonical Markdown.
6. Create version `v1` with operation `import`.
7. Store editor Yjs state and canonical mirror.

## Export contract

On export:

1. Use current canonical Markdown snapshot.
2. Do not inject metadata into the body by default.
3. Use metadata-rich filename.

Filename format:

```text
{slug}__EXPORT__doc-{docIdShort}__branch-{branchSlug}__v{versionNumber}__{yyyyMMdd-HHmmssZ}__sha-{hash8}__check-cloud-before-use.md
```

## AI contract

AI always receives canonical Markdown and must send edits against canonical Markdown.

`read_doc` response:

```json
{
  "doc_id": "doc_abc",
  "branch_id": "br_main",
  "version_id": "ver_043",
  "version_number": 43,
  "hash": "sha256:7b91a2cf...",
  "markdown": "# Strategy memo\n\n..."
}
```

Agent instruction:

```text
Treat exported local files as snapshots. Before using an exported file as current truth, call read_doc again and compare version/hash.
```
