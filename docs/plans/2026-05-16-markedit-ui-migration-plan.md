# Plan 5.5: MarkEdit UI Migration

> **For agentic workers:** REQUIRED SUB-SKILLS: Use superpowers:executing-plans and superpowers:test-driven-development. This plan replaces the current prototype native SwiftUI shell with a MarkEdit-derived macOS editor UI, then layers MarkLab collaboration into that shell.

**Goal:** Make MarkLab.app feel and behave like MarkEdit with collaboration added, not like a new minimal SwiftUI prototype. MarkEdit is the native editor foundation; MarkLab owns the collaboration, sharing, conflict, daemon, and control-plane layers.

**Architecture:** Port the relevant MarkEdit AppKit document/window/editor shell into `apps/marklab-macos`, preserve MIT attribution in copied/adapted files, then connect the existing MarkLab collaboration model through adapter objects. The native app must keep MarkEdit-style document editing as the primary local-file surface and expose collaboration as toolbar/sidebar/overlay affordances.

**Tech Stack:** MarkEdit `NSDocument` / `NSWindowController` / `EditorViewController` / `EditorWebView` patterns, MarkLab SwiftPM package, WebKit, existing MarkLab native clients, existing hosted `/collab` bridge during the first migration slice.

## Source References

- `Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Models/EditorDocument.swift`
- `Learning resources/MarkEdit/MarkEditMac/Sources/Editor/EditorWindowController.swift`
- `Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Controllers/EditorViewController*.swift`
- `Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorWebView.swift`
- `Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorStatusView.swift`
- `Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorPanelView.swift`
- `Learning resources/MarkEdit/MarkEditMac/Sources/Main/Application/AppDelegate*.swift`
- `Learning resources/MarkEdit/MarkEditKit/`
- `Learning resources/MarkEdit/MarkEditCore/`

## Copying And Attribution Rules

1. It is allowed and expected to copy relevant MarkEdit Swift/AppKit code into MarkLab-owned files.
2. Keep `Learning resources/` read-only: do not edit, move, delete, or stage anything inside it.
3. Every copied or closely adapted MarkEdit source file must include:
   - `// Adapted from MarkEdit, MIT licensed.`
   - `// Source: Learning resources/MarkEdit/<relative path>`
   - the MIT copyright/license notice where a substantial source body is copied.
4. MarkLab-specific collaboration code must remain clearly separated from MarkEdit-derived editor UI code so future upgrades can compare against upstream MarkEdit.

## Current Problem

Plan 4 chose the allowed **Reference** strategy and produced a working but minimal `VStack`/`TextEditor` app surface in `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift`. That was enough for collaboration runtime gates, but it violates the intended product shape: users should see a MarkEdit-like native Markdown editor with collaboration controls layered in.

## Target UX Contract

- Opening a file creates a MarkEdit-style document window/editor, not a generic single-window SwiftUI form.
- Local editing uses a MarkEdit-style WebKit/CodeMirror editor surface, not SwiftUI `TextEditor`.
- The app has native macOS editor chrome: document window, toolbar actions, status area, find/menu affordances where practical.
- Collaboration controls are additive: start sharing, create edit/view link, copy/revoke link, daemon status, restore, and conflict review appear as toolbar/sidebar/inspector/panel controls around the editor.
- During active collaboration, the hosted `/collab` bridge may remain the first sync engine, but it must be presented inside the MarkEdit-derived editor shell rather than replacing the whole app with a web-app frame.
- Conflict review remains preview-first and blocks only the conflicted document.

## Tasks

### Task 1: Lock The UI Strategy With Failing Tests

- [x] Add a native UI contract test that fails while `MarkLabRootView` still owns the product UI as a `VStack`/`TextEditor` prototype.
- [x] The test must assert that the app exposes a MarkEdit-derived shell descriptor with:
  - document-window mode;
  - MarkEdit source attribution;
  - WebKit/CodeMirror local editor mode;
  - collaboration controls as an overlay/inspector/toolbar layer.
- [x] Acceptance command: `swift test --package-path apps/marklab-macos --filter MarkLabNativeUIStrategyTests`.

### Task 2: Introduce MarkEdit-Derived Shell Types

- [x] Create a new `MarkEditShell` area under `apps/marklab-macos/Sources/MarkLabApp/`.
- [x] Add copied/adapted MarkEdit shell primitives with attribution:
  - document/window shell descriptor;
  - editor container;
  - status/toolbar model;
  - editor web view wrapper or bridge.
- [x] Keep these types small enough for SwiftPM and current tests; do not try to import the whole Xcode project in one step.
- [x] Replace the app entry point's primary content composition with the MarkEdit-derived shell.
- [x] Acceptance command: `swift test --package-path apps/marklab-macos --filter MarkLabNativeUIStrategyTests`.

### Task 3: Move Existing Collaboration UI Into The Shell Layer

- [x] Move current sharing actions into a MarkEdit-style toolbar/status/inspector layer:
  - open;
  - save;
  - start sharing;
  - create edit link;
  - create view link;
  - copy link;
  - revoke link;
  - daemon/version/restore status.
- [x] Ensure collaboration controls do not own the root editor layout.
- [x] Add tests that the shell exposes the collaboration commands without requiring the prototype `MarkLabRootView`.
- [x] Acceptance command: `swift test --package-path apps/marklab-macos`.

### Task 4: Replace Unshared `TextEditor` With A MarkEdit-Style Editor Surface

- [x] Add an AppKit/WebKit editor view for unshared local editing based on MarkEdit's `EditorWebView`/editor-container pattern.
- [x] Preserve exact local file bytes for unshared save behavior already covered by `LocalMarkdownDocumentTests`.
- [x] Keep the current hosted `/collab` WebView for shared editing as a bridge slice, but embed it in the shell.
- [x] Add tests or smoke assertions proving the prototype SwiftUI `TextEditor` is no longer the normal editor path.
- [x] Acceptance commands:
  - `swift test --package-path apps/marklab-macos`;
  - `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser`.

### Task 5: Conflict UI As MarkEdit-Style Panel

- [x] Move conflict preview/actions out of the root `VStack` and into a document-scoped panel/inspector.
- [x] Keep the existing resolution semantics:
  - accept local;
  - keep shared;
  - paste resolved Markdown;
  - guarded disk save;
  - active-provider verification.
- [x] Add Swift tests covering conflict action availability through the shell state.
- [x] Acceptance command: `swift test --package-path apps/marklab-macos`.

### Task 6: Documentation And Downstream Refresh

- [x] Update `docs/appdesigndoc.md` to replace the Plan 4 **Reference** strategy statement with the Plan 5.5 **Port MarkEdit UI** strategy.
- [x] Update downstream plans that mention native UI/package shape:
  - `docs/plans/2026-05-11-packaging-cli-distribution-docs.md`;
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`;
  - `docs/plans/2026-05-11-billing-subscription-seats.md` only if seat/client-kind wording changes.
- [x] Run `rg -n "MarkEdit|native|TextEditor|MarkLabRootView|WKWebView|collaboration UI|conflict" docs/plans docs/appdesigndoc.md`.
- [x] Commit docs separately if implementation and docs are split.

### Task 7: Verification And Review

- [x] Run `swift test --package-path apps/marklab-macos`.
- [x] Run `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser`.
- [x] Run relevant API/browser tests if shell wiring changes hosted collaboration behavior.
- [x] Run `git diff --check`.
- [x] Run one fresh holistic reviewer on the staged Plan 5.5 diff before commit.
- [x] Commit implementation with `git commit -m "feat: migrate native app to markedit ui shell"`.
- [x] Commit downstream docs with `git commit -m "docs: refresh plans after markedit ui migration"` if docs are separate.

## Non-Goals

- Do not fork MarkEdit into a separate repository.
- Do not rewrite the collaboration provider/control-plane/session stack.
- Do not remove the hosted `/collab` bridge until a bundled native CodeMirror/Yjs runtime is ready and equivalently tested.
- Do not ship a full MarkEdit feature clone in one pass; keep the first migration focused on the document/editor shell, editor surface, status/toolbar, and collaboration panels.
