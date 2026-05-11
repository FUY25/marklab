# MarkLab Learning Resources

Date: 2026-05-11

Status: Reference manifest for local-only external source clones.

## Policy

External repositories under `Learning resources/` are local learning materials only. They are not vendored code, not git submodules, and not part of the MarkLab product repository.

Rules:

- Do not commit external repository contents from `Learning resources/`.
- Record the upstream URL and inspected commit in this file whenever a learning resource is added or refreshed.
- Use these repositories for product, architecture, and implementation reference.
- If MarkLab adopts code, import the needed idea or implementation deliberately into MarkLab-owned files with licensing and attribution reviewed.
- Do not treat a learning clone as MarkLab's source of truth.

## Inspected Repositories

| Resource | Upstream | Local path | Inspected commit | MarkLab use |
| --- | --- | --- | --- | --- |
| MarkEdit | `https://github.com/MarkEdit-app/MarkEdit.git` | `Learning resources/MarkEdit` | `ff86752 Bump version numbers` | Native/local Markdown editor reference. Use for MarkEdit-oriented app behavior, CodeMirror/native editor direction, and local-file product feel. |
| Relay | `https://github.com/No-Instructions/Relay.git` | `Learning resources/Relay` | `4aa7f25 fix: Check download response status before writing file content (#80)` | Main collaboration architecture reference. Study Yjs/Y.Text sync, awareness, provider/control-plane split, offline/reconnect behavior, local persistence, and Relay-like conflict UX. Do not adopt Obsidian vault/file-tree scope for v1. |
| Y-Sweet | `https://github.com/jamsocket/y-sweet.git` | `Learning resources/y-sweet` | `4f1909b Allow to disable GC within documents using env variable/CLI (#422)` | Main provider implementation reference. Use for `DocumentManager`, `ClientToken`, `authorization: "full" | "read-only"`, token `validForSeconds`, provider connection, read-only write rejection tests, and self-host/deployment options. |
| CollabMD | `https://github.com/andes90/collabmd.git` | `Learning resources/collabmd` | `b993e2e chore(release): bump to version 0.1.39` | Browser collaboration UI/editor-shell reference only. Useful for Markdown collaboration layout, CodeMirror 6 presence/editor UX, and local-file workflow ideas. Do not adopt its sync/server model as MarkLab architecture. |
| Vditor | `https://github.com/vanessa219/vditor.git` | `Learning resources/vditor` | `86c2aaf :art: https://github.com/Vanessa219/vditor/pull/1853` | Phase 2 browser rich Markdown editor candidate. Useful because it is Markdown-string centered and supports `wysiwyg`, `ir`, and `sv` modes. Must pass MarkLab's Y.Text, cursor, highlight, and source-offset adapter tests before becoming an editable rich collaboration surface. |

## Refresh Checklist

When refreshing a resource:

1. Pull or reclone the external repository under `Learning resources/`.
2. Inspect the relevant source paths before drawing conclusions.
3. Update the inspected commit in this file.
4. Keep `Learning resources/` ignored by git.
5. Commit only MarkLab documentation or MarkLab-owned implementation files, not the external clone.
