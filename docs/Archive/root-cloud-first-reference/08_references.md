# Historical cloud-first reference. Superseded by docs/appdesigndoc.md; previous local-first plans are archived under docs/Archive/local-first-plans/.

# References

## Milkdown

- Milkdown homepage: https://milkdown.dev/  
  Notes: Milkdown is a plugin-driven WYSIWYG Markdown editor. The homepage states it supports collaborative editing with Y.js and is built on ProseMirror, Y.js, and Remark.

- Milkdown GitHub: https://github.com/Milkdown/milkdown  
  Notes: README describes Milkdown as a plugin-driven WYSIWYG Markdown editor inspired by Typora and built on ProseMirror and Remark.

- Local Milkdown source clone: `resource/milkdown` at commit `114b4b35` on 2026-04-29  
  Notes: Verified `@milkdown/kit@7.20.0`, `@milkdown/plugin-collab@7.20.0`, `collabServiceCtx`, `bindDoc`, `setAwareness`, `connect`, `applyTemplate`, `getMarkdown`, `replaceAll`, listener `markdownUpdated`, and Milkdown diff/streaming plugin transaction patterns. This is why the corrected plans treat Milkdown parser/serializer output as the semantic authority and require import/branch/live-writer paths to update Yjs/ProseMirror state, not only `current_markdown`.

- Milkdown Transformer API: https://milkdown.dev/docs/api/transformer  
  Notes: Transformer APIs convert between editor ProseMirror state and Markdown AST.

- Milkdown Architecture Overview: https://milkdown.dev/docs/guide/architecture-overview  
  Notes: Describes Markdown/Remark/ProseMirror transformation flow.

- Milkdown Collaborative Editing: https://milkdown.dev/docs/guide/collaborative-editing  
  Notes: Uses Yjs provider such as y-websocket and `@milkdown/plugin-collab`.

- Yjs Milkdown binding docs: https://beta.yjs.dev/docs/ecosystem/editor-bindings/milkdown/  
  Notes: Describes Milkdown as ProseMirror-based editor integrating Yjs as collaborative solution.

## Hocuspocus / Yjs

- Hocuspocus overview: https://tiptap.dev/docs/hocuspocus/getting-started/overview  
  Notes: Hocuspocus is based on Y.js and syncs/merges realtime changes.

- Hocuspocus persistence: https://tiptap.dev/docs/hocuspocus/guides/persistence  
  Notes: Yjs state should be persisted as `Uint8Array` binary. Do not recreate Yjs binary from JSON as primary storage.

- Hocuspocus server usage: https://tiptap.dev/docs/hocuspocus/server/usage  
  Notes: Includes server usage and direct connection patterns for server-side operations.

- npm package metadata checked on 2026-04-29: `@hocuspocus/server@4.0.0`, `@hocuspocus/provider@4.0.0`  
  Notes: Updated implementation plans from the older `^3.0.0` assumption to the current major and kept typecheck as the API lock.

- Yjs document updates: https://docs.yjs.dev/api/document-updates  
  Notes: Yjs updates are binary and are commutative, associative, and idempotent.

## Claude Code / Anthropic editing model

- Claude Code hooks: https://code.claude.com/docs/en/hooks  
  Notes: Public hook schema includes tools such as `Read`, `Write`, and `Edit`; `Write` creates/overwrites files and `Edit` replaces strings in existing files.

- Anthropic text editor tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool  
  Notes: Text editor tool includes string replacement and insert semantics. MVP chooses Claude Code-like `Edit` and represents insert through MarkLab `oldString/newString` fields.

## HackMD / CodiMD references

- HackMD: https://hackmd.io/  
  Notes: Mature collaborative Markdown product; useful competitor reference.

- HackMD CLI: https://github.com/hackmdio/hackmd-cli  
  Notes: Useful reference for CLI/API agent access; primarily updates note content.

- CodiMD: https://github.com/hackmdio/codimd  
  Notes: Self-hosted real-time collaborative Markdown editor; useful reference, not recommended as the core fork.

## Deployment

- Vercel limits: https://vercel.com/docs/limits  
  Notes: Vercel Functions do not support acting as a WebSocket server.

- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/  
  Notes: Useful future architecture for stateful realtime coordination. Not required for MVP.
