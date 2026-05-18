import AppKit
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
  @State private var collaborationInspectorPresented = false
  @State private var editorSelectionStatus = "Ln 1, Col 1"
  @State private var editorCommandSequence = 0
  @State private var editorCommand: MarkEditLocalEditorCommand?

  var body: some View {
    ZStack(alignment: .bottom) {
      editorSurface
      editorStatusOverlay
    }
    .frame(
      minWidth: 360,
      idealWidth: 720,
      minHeight: 260,
      idealHeight: 480
    )
    .background(Color(nsColor: .textBackgroundColor))
    .background(MarkEditWindowFrameApplier(filePath: model.filePath))
    .focusedSceneValue(
      \.markEditShellActions,
      MarkEditShellActions(
        open: { model.openFile() },
        save: { model.saveFileFromUI() },
        canSave: model.filePath != nil && model.conflict == nil
      )
    )
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        tableOfContentsToolbarMenu
        headingToolbarMenu
        emphasisToolbarGroup
        listToolbarMenu
        collaborationToolbarMenu
      }
    }
    .inspector(isPresented: collaborationInspectorBinding) {
      inspector
        .inspectorColumnWidth(min: 300, ideal: 320, max: 420)
    }
    .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in
      model.ingestExternalFileChanges()
    }
    .onChange(of: requiresCollaborationInspector) { _, requiresInspector in
      if requiresInspector {
        collaborationInspectorPresented = true
      }
    }
    .onChange(of: hasCollaborationInspectorContent) { _, hasContent in
      if !hasContent {
        collaborationInspectorPresented = false
      }
    }
  }

  @ViewBuilder
  private var editorSurface: some View {
    ZStack {
      if let embeddedCollabURL = model.embeddedCollabURL {
        HostedCollabWebView(
          url: embeddedCollabURL,
          diskIngestion: model.pendingDiskIngestion,
          nativeBearerToken: model.nativeBearerToken,
          command: editorCommand,
          isEditable: model.conflict == nil,
          onMarkdownSnapshot: { markdown in model.projectSharedMarkdownFromWebView(markdown) },
          onDiskIngestionResult: { result in model.handleDiskIngestionBridgeResult(result) }
        )
      } else {
        MarkEditLocalMarkdownEditorView(
          text: $model.text,
          selectionStatusText: $editorSelectionStatus,
          isEditable: model.filePath != nil && model.conflict == nil,
          command: editorCommand
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

  private var hasCollaborationInspectorContent: Bool {
    model.latestLink != nil || model.localDaemonContext != nil || model.conflict != nil
  }

  private var tableOfContentsToolbarMenu: some View {
    Menu {
      if markdownHeadings.isEmpty {
        Button("No Headings") {}
          .disabled(true)
      } else {
        ForEach(markdownHeadings) { heading in
          Button(heading.menuTitle) {
            runEditorCommand(.gotoLine(heading.lineNumber))
          }
        }
      }
    } label: {
      Label("Table of Contents", systemImage: "list.bullet.rectangle")
    }
    .help("Table of Contents")
    .disabled(!localFormattingEnabled || markdownHeadings.isEmpty)
  }

  private var headingToolbarMenu: some View {
    Menu {
      ForEach(1...6, id: \.self) { level in
        Button("Heading \(level)") { runEditorCommand(.heading(level)) }
      }
    } label: {
      Label("Heading", systemImage: "number")
    }
    .help("Heading")
    .disabled(!localFormattingEnabled)
  }

  private var emphasisToolbarGroup: some View {
    ControlGroup {
      Button {
        runEditorCommand(.bold)
      } label: {
        Label("Bold", systemImage: "bold")
      }
      .help("Bold")

      Button {
        runEditorCommand(.italic)
      } label: {
        Label("Italic", systemImage: "italic")
      }
      .help("Italic")
    }
    .disabled(!localFormattingEnabled)
  }

  private var listToolbarMenu: some View {
    Menu {
      Button("Bulleted List") { runEditorCommand(.unorderedList) }
      Button("Numbered List") { runEditorCommand(.orderedList) }
      Button("Task List") { runEditorCommand(.taskList) }
    } label: {
      Label("List", systemImage: "list.bullet")
    }
    .help("List")
    .disabled(!localFormattingEnabled)
  }

  private var collaborationToolbarMenu: some View {
    Menu {
      Button { model.startSharing() } label: {
        Label("Start Sharing", systemImage: "person.2")
      }
      .disabled(!model.actionsEnabled)

      Divider()

      Button { model.createLink(role: .edit) } label: {
        Label("Create Edit Link", systemImage: "pencil")
      }
      .disabled(!model.actionsEnabled)

      Button { model.createLink(role: .view) } label: {
        Label("Create View Link", systemImage: "eye")
      }
      .disabled(!model.actionsEnabled)

      Button { model.copyLatestLink() } label: {
        Label("Copy Link", systemImage: "doc.on.doc")
      }
      .disabled(model.latestLink == nil)

      Button { model.revokeLatestLink() } label: {
        Label("Revoke Link", systemImage: "xmark.circle")
      }
      .disabled(model.latestGrantId == nil)

      Divider()

      Button {
        collaborationInspectorPresented.toggle()
      } label: {
        Label("Show Collaboration", systemImage: "sidebar.right")
      }
      .disabled(!hasCollaborationInspectorContent)
    } label: {
      Label("Collaboration", systemImage: "link")
    }
    .help("Collaboration")
  }

  private var localFormattingEnabled: Bool {
    model.filePath != nil && model.conflict == nil
  }

  private var markdownHeadings: [MarkEditMarkdownHeading] {
    Self.markdownHeadingsForTesting(model.text)
  }

  private var requiresCollaborationInspector: Bool {
    model.conflict != nil
  }

  private var collaborationInspectorBinding: Binding<Bool> {
    Binding(
      get: { collaborationInspectorPresented && hasCollaborationInspectorContent },
      set: { collaborationInspectorPresented = $0 }
    )
  }

  private var inspector: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text("Collaboration")
          .font(.headline)
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
    .background(.regularMaterial)
  }

  private var editorStatusOverlay: some View {
    HStack {
      if let operationalStatus {
        statusPill(operationalStatus)
          .frame(maxWidth: 420, alignment: .leading)
      }
      Spacer()
      statusPill(statusSummary)
    }
    .font(.caption)
    .padding(14)
    .allowsHitTesting(false)
  }

  private func statusPill(_ text: String) -> some View {
    Text(text)
      .lineLimit(1)
      .truncationMode(.middle)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .stroke(Color(nsColor: .separatorColor).opacity(0.6), lineWidth: 1)
      }
  }

  private var statusSummary: String {
    if model.conflict != nil { return "Sync Paused" }
    if model.embeddedCollabURL != nil { return "Collaborating" }
    if model.filePath != nil { return editorSelectionStatus }
    return "No File"
  }

  private var operationalStatus: String? {
    Self.operationalStatusTextForTesting(model.statusText, filePath: model.filePath)
  }

  static func operationalStatusTextForTesting(_ statusText: String, filePath: String?) -> String? {
    let trimmed = statusText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.hasPrefix("Open a Markdown file") { return nil }
    if let filePath {
      let filename = URL(fileURLWithPath: filePath).lastPathComponent
      if trimmed == "Editing \(filename)." { return nil }
    }
    return trimmed
  }

  static func markdownHeadingsForTesting(_ markdown: String) -> [MarkEditMarkdownHeading] {
    let lines = markdown
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
    var headings: [MarkEditMarkdownHeading] = []
    var inFencedCodeBlock = false
    var fenceMarker: Character?
    var fenceLength = 0

    for (index, line) in lines.enumerated() {
      let lineNumber = index + 1
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      guard !line.hasPrefix("\t"), !line.hasPrefix("    ") else { continue }
      if let fence = MarkdownFence(line: trimmed) {
        if inFencedCodeBlock {
          if fence.marker == fenceMarker, fence.length >= fenceLength {
            inFencedCodeBlock = false
            fenceMarker = nil
            fenceLength = 0
          }
        } else {
          inFencedCodeBlock = true
          fenceMarker = fence.marker
          fenceLength = fence.length
        }
        continue
      }
      guard !inFencedCodeBlock else { continue }

      if let atxHeading = MarkEditMarkdownHeading(atxLine: line, lineNumber: lineNumber) {
        headings.append(atxHeading)
        continue
      }

      guard index > 0 else { continue }
      let marker = trimmed
      guard marker.allSatisfy({ $0 == "=" }) || marker.allSatisfy({ $0 == "-" }) else { continue }
      guard !marker.isEmpty else { continue }
      let previousLine = lines[index - 1]
      guard
        !previousLine.hasPrefix("\t"),
        !previousLine.hasPrefix("    "),
        MarkEditMarkdownHeading(atxLine: previousLine, lineNumber: index) == nil
      else {
        continue
      }
      let title = previousLine.trimmingCharacters(in: .whitespaces)
      guard !title.isEmpty else { continue }
      headings.append(
        MarkEditMarkdownHeading(
          lineNumber: index,
          level: marker.first == "=" ? 1 : 2,
          title: title
        )
      )
    }
    return headings
  }

  private func runEditorCommand(_ action: MarkEditLocalEditorCommandAction) {
    editorCommandSequence += 1
    editorCommand = MarkEditLocalEditorCommand(sequence: editorCommandSequence, action: action)
  }

  private func inspectorSection<Content: View>(
    _ title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.subheadline.weight(.semibold))
      content()
    }
  }
}

private struct MarkdownFence {
  let marker: Character
  let length: Int

  init?(line: String) {
    guard let first = line.first, first == "`" || first == "~" else { return nil }
    let length = line.prefix { $0 == first }.count
    guard length >= 3 else { return nil }
    self.marker = first
    self.length = length
  }
}

struct MarkEditMarkdownHeading: Identifiable, Equatable {
  let lineNumber: Int
  let level: Int
  let title: String

  var id: Int { lineNumber }

  var menuTitle: String {
    "\(String(repeating: "#", count: level)) \(title)"
  }

  init(lineNumber: Int, level: Int, title: String) {
    self.lineNumber = lineNumber
    self.level = level
    self.title = title
  }

  init?(atxLine line: String, lineNumber: Int) {
    guard !line.hasPrefix("\t"), !line.hasPrefix("    ") else { return nil }
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let level = trimmed.prefix { $0 == "#" }.count
    guard (1...6).contains(level) else { return nil }
    let rest = trimmed.dropFirst(level)
    guard rest.isEmpty || rest.first == " " else { return nil }
    let rawTitle = rest.trimmingCharacters(in: .whitespaces)
    let title = rawTitle.replacingOccurrences(
      of: #"(?<=\s)#+\s*$"#,
      with: "",
      options: .regularExpression
    )
    .trimmingCharacters(in: .whitespaces)
    guard !title.isEmpty else { return nil }
    self.lineNumber = lineNumber
    self.level = level
    self.title = title
  }
}

struct MarkEditShellActions {
  let open: () -> Void
  let save: () -> Void
  let canSave: Bool
}

private struct MarkEditShellActionsKey: FocusedValueKey {
  typealias Value = MarkEditShellActions
}

extension FocusedValues {
  var markEditShellActions: MarkEditShellActions? {
    get { self[MarkEditShellActionsKey.self] }
    set { self[MarkEditShellActionsKey.self] = newValue }
  }
}

private struct MarkEditWindowFrameApplier: NSViewRepresentable {
  let filePath: String?

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeNSView(context: Context) -> NSView {
    NSView(frame: .zero)
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    applyWhenWindowIsAvailable(from: nsView, context: context, remainingAttempts: 20)
  }

  private func applyWhenWindowIsAvailable(
    from nsView: NSView,
    context: Context,
    remainingAttempts: Int
  ) {
    guard let window = nsView.window else {
      guard remainingAttempts > 0 else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        applyWhenWindowIsAvailable(
          from: nsView,
          context: context,
          remainingAttempts: remainingAttempts - 1
        )
      }
      return
    }
    applyDocumentIdentity(to: window)
    if !context.coordinator.didApply {
      MarkEditDocumentWindowSizer.configureInitialFrame(for: window)
    }
    context.coordinator.didApply = true
  }

  private func applyDocumentIdentity(to window: NSWindow) {
    if let filePath {
      let url = URL(fileURLWithPath: filePath)
      window.title = url.lastPathComponent
      window.representedURL = url
    } else {
      window.title = "MarkLab"
      window.representedURL = nil
    }
  }

  final class Coordinator {
    var didApply = false
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
