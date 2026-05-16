import SwiftUI
import MarkLabMacOS

// Adapted from MarkEdit, MIT licensed.
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/EditorWindowController.swift
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorStatusView.swift
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorPanelView.swift
// Copyright (c) 2023 MarkEdit.app.

struct MarkEditDocumentShellView: View {
  @ObservedObject var model: MarkLabAppModel
  let descriptor = MarkEditShellDescriptor.current

  var body: some View {
    VStack(spacing: 0) {
      toolbar
      Divider()
      HStack(spacing: 0) {
        editorSurface
        if showsInspector {
          Divider()
          inspector
            .frame(width: 320)
        }
      }
      Divider()
      statusBar
    }
    .frame(minWidth: 840, minHeight: 560)
    .background(Color(nsColor: .textBackgroundColor))
    .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in
      model.ingestExternalFileChanges()
    }
  }

  private var toolbar: some View {
    HStack(spacing: 8) {
      Text("MarkLab")
        .font(.headline)
      if let filePath = model.filePath {
        Text(URL(fileURLWithPath: filePath).lastPathComponent)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer()
      Button("Open") { model.openFile() }
      Button("Save") { model.saveFileFromUI() }
        .disabled(model.filePath == nil || model.conflict != nil)
      Divider()
        .frame(height: 20)
      Button("Start Sharing") { model.startSharing() }
        .disabled(!model.actionsEnabled)
      Menu("Link") {
        Button("Create Edit Link") { model.createLink(role: .edit) }
          .disabled(!model.actionsEnabled)
        Button("Create View Link") { model.createLink(role: .view) }
          .disabled(!model.actionsEnabled)
        Button("Copy Link") { model.copyLatestLink() }
          .disabled(model.latestLink == nil)
        Button("Revoke Link") { model.revokeLatestLink() }
          .disabled(model.latestGrantId == nil)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  @ViewBuilder
  private var editorSurface: some View {
    ZStack {
      if let embeddedCollabURL = model.embeddedCollabURL {
        HostedCollabWebView(
          url: embeddedCollabURL,
          diskIngestion: model.pendingDiskIngestion,
          nativeBearerToken: model.nativeBearerToken,
          onMarkdownSnapshot: { markdown in model.projectSharedMarkdownFromWebView(markdown) },
          onDiskIngestionResult: { result in model.handleDiskIngestionBridgeResult(result) }
        )
        .opacity(model.conflict == nil ? 1 : 0)
        .allowsHitTesting(model.conflict == nil)
        .accessibilityHidden(model.conflict != nil)
      } else {
        MarkEditLocalMarkdownEditorView(
          text: $model.text,
          isEditable: model.filePath != nil && model.conflict == nil
        )
      }

      if model.filePath == nil {
        Text("Open a Markdown file")
          .foregroundStyle(.secondary)
          .padding(12)
          .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var showsInspector: Bool {
    model.latestLink != nil || model.localDaemonContext != nil || model.conflict != nil
  }

  private var inspector: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if let latestLink = model.latestLink {
          inspectorSection("Browser Link") {
            Text(latestLink)
              .font(.caption)
              .textSelection(.enabled)
          }
        }
        if let context = model.localDaemonContext {
          inspectorSection("Local Daemon") {
            Text("\(context.shareState.hostOnline ? "online" : "offline") · versions \(context.versions.count)")
              .font(.caption)
              .foregroundStyle(.secondary)
            Button("Restore Latest Version") { model.restoreLatestVersion() }
              .disabled(context.versions.isEmpty || model.conflict != nil)
          }
        }
        if let conflict = model.conflict {
          MarkEditConflictPanelView(model: model, conflict: conflict)
        }
      }
      .padding(14)
    }
    .background(Color(nsColor: .controlBackgroundColor))
  }

  private var statusBar: some View {
    HStack(spacing: 10) {
      Text(model.statusText)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer()
      Text(statusSummary)
        .foregroundStyle(.secondary)
    }
    .font(.caption)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private var statusSummary: String {
    if model.conflict != nil { return "sync paused" }
    if model.embeddedCollabURL != nil { return "collaborating" }
    if model.filePath != nil { return "local" }
    return descriptor.sourceAttribution
  }

  private func inspectorSection<Content: View>(
    _ title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.headline)
      content()
    }
  }
}

private struct MarkEditConflictPanelView: View {
  @ObservedObject var model: MarkLabAppModel
  let conflict: MarkLabConflict

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Conflict")
        .font(.headline)
      Text("local \(conflict.localHash.prefix(12)) · shared \(conflict.sharedHash.prefix(12)) · base \(conflict.baselineHash.prefix(12))")
        .font(.caption)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      previewBlock("Local disk", conflict.localMarkdown)
      previewBlock("Shared editor", conflict.sharedMarkdown)
      previewBlock("Base", conflict.baselineMarkdown)
      previewBlock("Conflict diff", conflict.diffPreview)
      HStack {
        Button("Accept Local") { model.acceptLocalConflictVersion() }
          .disabled(!model.canResolveConflictThroughSharedEditor)
        Button("Keep Shared") { model.keepSharedConflictVersion() }
          .disabled(!model.canResolveConflictThroughSharedEditor)
      }
      Text("Resolved Markdown")
        .font(.caption)
      TextEditor(text: $model.resolvedConflictMarkdown)
        .font(.system(.caption, design: .monospaced))
        .frame(minHeight: 96)
      Text("Resolved preview")
        .font(.caption)
        .foregroundStyle(.secondary)
      previewBlock(nil, model.resolvedConflictMarkdown, minHeight: 54)
      TextField("Type APPLY RESOLVED to confirm", text: $model.resolvedConflictConfirmation)
        .textFieldStyle(.roundedBorder)
      Button("Apply Resolved Markdown") { model.resolveConflictWithMergedMarkdown() }
        .disabled(!model.canApplyResolvedConflictMarkdown)
    }
  }

  private func previewBlock(_ title: String?, _ markdown: String, minHeight: CGFloat = 68) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if let title {
        Text(title)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      ScrollView {
        Text(markdown.isEmpty ? " " : markdown)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(8)
      }
      .frame(minHeight: minHeight, maxHeight: 132)
      .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
    }
  }
}
