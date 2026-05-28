import AppKit
import SwiftUI
import MarkLabMacOS

enum MarkEditOperationalStatusSeverity: Equatable {
  case normal
  case error
}

enum MarkEditDocumentSurfaceMode: Equatable {
  case editor
  case conflictReview
}

enum MarkEditConflictReviewMode: String, CaseIterable, Identifiable {
  case review
  case manualMerge

  var id: String { rawValue }

  var label: String {
    switch self {
    case .review:
      return "Review"
    case .manualMerge:
      return "Manual Merge"
    }
  }
}

enum MarkEditSharingVersionsInspectorMode: String, CaseIterable, Identifiable {
  case sharing
  case versions

  var id: String { rawValue }

  var label: String {
    switch self {
    case .sharing:
      return "Sharing"
    case .versions:
      return "Versions"
    }
  }
}

// Adapted from MarkEdit, MIT licensed.
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/EditorWindowController.swift
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorStatusView.swift
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorPanelView.swift
// Copyright (c) 2023 MarkEdit.app.

struct MarkEditDocumentShellView: View {
  static let openMarkdownButtonTitle = "Open a Markdown file"
  static let sharingAndVersionsLabel = "Sharing & Versions"
  static let showSharingAndVersionsLabel = "Show Sharing & Versions"
  static let cloudCopySectionTitle = "Cloud Copy"
  static let versionHistorySectionTitle = "Version History"
  static let saveVersionButtonTitle = "Save Checkpoint"
  static let restoreVersionButtonTitle = "Restore This Version"
  static let restoreVersionConfirmationPrompt = "Type RESTORE to confirm"
  static let restoreVersionExplanation = "Restoring creates a new current rollback version. Old snapshots stay in version history, and the local Markdown file updates through normal shared projection."
  static let deleteCloudCopySummary = "Deletes the hosted copy, online version history, access links, and active cloud sessions. The local Markdown file stays on disk."
  static let deleteCloudCopyButtonTitle = "Delete Cloud Copy"
  static let deleteCloudCopyConfirmationPrompt = "Type DELETE CLOUD COPY to confirm"
  static let cloudCopyRetentionSummary = "Cloud copy and online version history are kept after Stop Sharing."
  static let stopSharingHelpText = "Stops sync and revokes active links. Cloud copy and version history are kept."
  private static let sharingToolbarActiveBackgroundOpacity = 0.16

  static func sharingToolbarIconNameForTesting(hasSharedDocument: Bool) -> String {
    sharingToolbarIconName(hasSharedDocument: hasSharedDocument)
  }

  static func sharingToolbarUsesActiveTintForTesting(hasSharedDocument: Bool) -> Bool {
    hasSharedDocument
  }

  static func sharingToolbarBackgroundOpacityForTesting(hasSharedDocument: Bool) -> Double {
    hasSharedDocument ? sharingToolbarActiveBackgroundOpacity : 0
  }

  static func sharingToolbarIconTintForTesting(hasSharedDocument: Bool) -> String {
    hasSharedDocument ? "systemBlue" : "primary"
  }

  static func versionDisplayTitleForTesting(filePath: String?, createdAt: String, timeZone: TimeZone = .current) -> String {
    versionDisplayTitle(filePath: filePath, createdAt: createdAt, timeZone: timeZone)
  }

  static func versionOperationLabelForTesting(_ operation: NativeVersionOperation) -> String {
    versionOperationLabel(operation)
  }

  static func versionMetadataLineForTesting(operation: NativeVersionOperation, versionNumber: Int) -> String {
    versionMetadataLine(operation: operation, versionNumber: versionNumber)
  }

  private static func versionDisplayTitle(filePath: String?, createdAt: String, timeZone: TimeZone = .current) -> String {
    let fileName = versionFileName(from: filePath)
    let timestamp = versionTimestampLabel(createdAt, timeZone: timeZone)
    return "\(fileName) - \(timestamp)"
  }

  private static func versionFileName(from filePath: String?) -> String {
    guard let filePath, !filePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return "Markdown document"
    }
    let lastPathComponent = URL(fileURLWithPath: filePath).lastPathComponent
    return lastPathComponent.isEmpty ? "Markdown document" : lastPathComponent
  }

  private static func versionTimestampLabel(_ createdAt: String, timeZone: TimeZone = .current) -> String {
    guard let date = versionISO8601Date(from: createdAt) else {
      return createdAt
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = "yyyy-MM-dd HH:mm"
    let zone = timeZone.secondsFromGMT(for: date) == 0
      ? "UTC"
      : (timeZone.abbreviation(for: date) ?? timeZone.identifier)
    return "\(formatter.string(from: date)) \(zone)"
  }

  private static func versionISO8601Date(from value: String) -> Date? {
    let standardFormatter = ISO8601DateFormatter()
    if let date = standardFormatter.date(from: value) {
      return date
    }
    let fractionalFormatter = ISO8601DateFormatter()
    fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractionalFormatter.date(from: value)
  }

  private static func versionOperationLabel(_ operation: NativeVersionOperation) -> String {
    switch operation {
    case .autosave:
      return "Auto checkpoint"
    case .manualSave:
      return "Manual checkpoint"
    case .rollback:
      return "Rollback checkpoint"
    case .import:
      return "Initial import"
    case .create:
      return "Created"
    case .write:
      return "Write checkpoint"
    case .edit:
      return "Edit checkpoint"
    case .branch:
      return "Branch checkpoint"
    }
  }

  private static func versionMetadataLine(operation: NativeVersionOperation, versionNumber: Int) -> String {
    "\(versionOperationLabel(operation)) · #\(versionNumber)"
  }

  private static func sharingToolbarIconName(hasSharedDocument: Bool) -> String {
    "link"
  }

  @ObservedObject var model: MarkLabAppModel
  let descriptor = MarkEditShellDescriptor.current
  private let retainsSharedDocumentOnDisappear: Bool
  @State private var collaborationInspectorPresented = false
  @State private var sharingVersionsMode: MarkEditSharingVersionsInspectorMode = .sharing
  @State private var editorSelectionStatus = "Ln 1, Col 1"
  @State private var editorCommandSequence = 0
  @State private var editorCommand: MarkEditLocalEditorCommand?

  init(model: MarkLabAppModel, retainsSharedDocumentOnDisappear: Bool = true) {
    self.model = model
    self.retainsSharedDocumentOnDisappear = retainsSharedDocumentOnDisappear
  }

  var body: some View {
    ZStack(alignment: .bottom) {
      editorSurface
      if model.conflict == nil {
        editorStatusOverlay
      }
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
        openSharedLink: { model.openSharedLink() },
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
        .inspectorColumnWidth(min: 340, ideal: 380, max: 520)
    }
    .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in
      model.ingestExternalFileChanges()
    }
    .onDisappear {
      _ = try? model.flushLocalAutosave()
      if retainsSharedDocumentOnDisappear {
        model.retainSharedDocumentForBackgroundIfNeeded()
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
      editorHostSurface

      if let conflict = model.conflict {
        MarkEditConflictReviewView(model: model, conflict: conflict)
      }

      if model.filePath == nil && model.conflict == nil {
        Button {
          model.openFile()
        } label: {
          Label(Self.openMarkdownButtonTitle, systemImage: "doc.text")
            .foregroundStyle(.secondary)
            .padding(12)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help(Self.openMarkdownButtonTitle)
        .accessibilityLabel(Self.openMarkdownButtonTitle)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder
  private var editorHostSurface: some View {
    if let embeddedCollabURL = model.embeddedCollabURL {
      HostedCollabWebView(
        url: embeddedCollabURL,
        diskIngestion: model.pendingDiskIngestion,
        nativeBearerToken: model.nativeBearerToken,
        command: editorCommand,
        isEditable: model.conflict == nil,
        onMarkdownSnapshot: { markdown in model.projectSharedMarkdownFromWebView(markdown) },
        onSelectionStatus: { status in editorSelectionStatus = status },
        onCollaboratorsChange: { collaborators in model.receiveActiveCollaborators(collaborators) },
        onDiskIngestionResult: { result in model.handleDiskIngestionBridgeResult(result) }
      )
    } else {
      MarkEditLocalMarkdownEditorView(
        text: localEditorTextBinding,
        selectionStatusText: $editorSelectionStatus,
        isEditable: model.filePath != nil && model.conflict == nil,
        command: editorCommand
      )
    }
  }

  private var hasCollaborationInspectorContent: Bool {
    Self.sharingVersionsInspectorAvailableForTesting(
      filePath: model.filePath,
      hasSharedDocument: model.hasSharedDocument,
      hasManagedAccessLinks: !model.managedAccessLinks.isEmpty,
      hasActiveCollaborators: !model.activeCollaborators.isEmpty,
      hasConflict: model.conflict != nil
    )
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
      if !model.hasSharedDocument {
        Button { model.startSharing() } label: {
          Label("Start Sharing", systemImage: "person.2")
        }
        .disabled(!model.canStartSharing)
      }

      if model.hasSharedDocument {
        Button {} label: {
          Label("Sharing On", systemImage: "checkmark.circle")
        }
        .disabled(true)

        Button { model.stopSharing() } label: {
          Label("Stop Sharing", systemImage: "xmark.circle")
        }
        .help(Self.stopSharingHelpText)
        .disabled(!model.canStopSharing)

        Divider()

        Button { model.createLink(role: .edit) } label: {
          Label("Create Edit Link", systemImage: "pencil")
        }
        .disabled(!model.canCreateSharingLink)

        Button { model.createLink(role: .view) } label: {
          Label("Create View Link", systemImage: "eye")
        }
        .disabled(!model.canCreateSharingLink)
      }

      Divider()

      Button {
        collaborationInspectorPresented.toggle()
      } label: {
        Label(Self.showSharingAndVersionsLabel, systemImage: "sidebar.right")
      }
      .disabled(!hasCollaborationInspectorContent)
    } label: {
      collaborationToolbarLabel
    }
    .help(Self.sharingAndVersionsLabel)
    .tint(model.hasSharedDocument ? Color(nsColor: .systemBlue) : Color.primary)
  }

  private var collaborationToolbarLabel: some View {
    Label {
      Text(Self.sharingAndVersionsLabel)
    } icon: {
      Image(systemName: Self.sharingToolbarIconName(hasSharedDocument: model.hasSharedDocument))
        .renderingMode(.template)
        .symbolRenderingMode(.monochrome)
        .foregroundStyle(model.hasSharedDocument ? Color(nsColor: .systemBlue) : Color.primary)
    }
    .foregroundStyle(model.hasSharedDocument ? Color(nsColor: .systemBlue) : Color.primary)
    .padding(.horizontal, model.hasSharedDocument ? 6 : 0)
    .padding(.vertical, model.hasSharedDocument ? 3 : 0)
    .background(
      Color(nsColor: .systemBlue)
        .opacity(model.hasSharedDocument ? Self.sharingToolbarActiveBackgroundOpacity : 0),
      in: RoundedRectangle(cornerRadius: 6, style: .continuous)
    )
  }

  private var localFormattingEnabled: Bool {
    model.filePath != nil && model.conflict == nil
  }

  private var localEditorTextBinding: Binding<String> {
    Binding(
      get: { model.text },
      set: { model.receiveLocalEditorMarkdown($0) }
    )
  }

  private var markdownHeadings: [MarkEditMarkdownHeading] {
    Self.markdownHeadingsForTesting(model.text)
  }

  private var collaborationInspectorBinding: Binding<Bool> {
    Binding(
      get: { collaborationInspectorPresented && hasCollaborationInspectorContent },
      set: { collaborationInspectorPresented = $0 }
    )
  }

  private var inspector: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        inspectorHeader
        Picker("", selection: $sharingVersionsMode) {
          ForEach(MarkEditSharingVersionsInspectorMode.allCases) { mode in
            Text(mode.label).tag(mode)
          }
        }
        .pickerStyle(.segmented)
        .labelsHidden()

        switch sharingVersionsMode {
        case .sharing:
          sharingInspectorContent
        case .versions:
          versionsInspectorContent
        }

        if let conflict = model.conflict {
          conflictInspectorSummary(conflict)
        }
      }
      .padding(16)
    }
    .background(.regularMaterial)
  }

  private var inspectorHeader: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(Self.sharingAndVersionsLabel)
        .font(.headline)
      Text(sharingVersionsSubtitle)
        .font(.callout)
        .foregroundStyle(.secondary)
    }
  }

  private var sharingInspectorContent: some View {
    VStack(alignment: .leading, spacing: 14) {
      if model.hasSharedDocument {
        inspectorSection("Access Links") {
          HStack {
            Button("Create Edit Link") { model.createLink(role: .edit) }
              .disabled(!model.canCreateSharingLink)
            Button("Create View Link") { model.createLink(role: .view) }
              .disabled(!model.canCreateSharingLink)
          }
          if model.managedAccessLinks.isEmpty {
            Text("No access links created.")
              .font(.callout)
              .foregroundStyle(.secondary)
          } else {
            ForEach(model.managedAccessLinks) { link in
              accessLinkRow(link)
            }
          }
        }

        inspectorSection("Active Collaborators") {
          if model.activeCollaborators.isEmpty {
            Text("No other connected sessions.")
              .font(.callout)
              .foregroundStyle(.secondary)
          } else {
            ForEach(model.activeCollaborators) { collaborator in
              collaboratorRow(collaborator)
            }
          }
        }

        inspectorSection("Local Sync") {
          Text(localSyncSummary)
            .font(.callout)
            .foregroundStyle(.secondary)
          if let filePath = model.filePath {
            Text(filePath)
              .font(.caption)
              .lineLimit(2)
              .truncationMode(.middle)
              .textSelection(.enabled)
          }
          Button("Stop Sharing") { model.stopSharing() }
            .help(Self.stopSharingHelpText)
            .disabled(!model.canStopSharing)
        }
      } else {
        inspectorSection("Start Sharing") {
          Text("Create a hosted copy to share this Markdown file and start online version history.")
            .font(.callout)
            .foregroundStyle(.secondary)
          Button("Start Sharing") { model.startSharing() }
            .disabled(!model.canStartSharing)
        }
      }

      inspectorSection(Self.cloudCopySectionTitle) {
        Text(Self.cloudCopyRetentionSummary)
          .font(.callout)
          .foregroundStyle(.secondary)
        if model.retainedCloudCopyAvailable {
          Text("Open Versions to review, restore, or delete the retained cloud copy.")
            .font(.callout)
            .foregroundStyle(.secondary)
        } else if !model.hasSharedDocument {
          Text("Cloud restore will appear here when a retained cloud copy is linked to this local file.")
            .font(.callout)
            .foregroundStyle(.secondary)
        }
      }
    }
    .onAppear {
      model.refreshManagedAccessLinksIfNeeded()
    }
  }

  private var versionsInspectorContent: some View {
    VStack(alignment: .leading, spacing: 14) {
      inspectorSection(Self.versionHistorySectionTitle) {
        if model.hasCloudCopyReference {
          HStack {
            if model.hasSharedDocument {
              Button(Self.saveVersionButtonTitle) {
                Task { await model.saveVersionSnapshot() }
              }
              .disabled(model.conflict != nil)
            }

            Button("Refresh") {
              Task { await model.loadVersionHistory() }
            }
            .disabled(model.isLoadingVersions)
          }

          if model.isLoadingVersions {
            ProgressView()
              .controlSize(.small)
          } else if model.versionHistory.isEmpty {
            Text("No online versions are available yet.")
              .font(.callout)
              .foregroundStyle(.secondary)
          } else {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(model.versionHistory) { version in
                versionRow(version)
              }
            }
          }
        } else {
          Text("Start sharing before online version history is available.")
            .font(.callout)
            .foregroundStyle(.secondary)
        }
      }

      if model.hasCloudCopyReference {
        inspectorSection("Selected Version") {
          selectedVersionContent
        }
      }

      inspectorSection("Danger Zone") {
        Text(Self.deleteCloudCopySummary)
          .font(.callout)
          .foregroundStyle(.secondary)
        if model.hasCloudCopyReference {
          TextField(Self.deleteCloudCopyConfirmationPrompt, text: $model.deleteCloudCopyConfirmation)
            .textFieldStyle(.roundedBorder)
          Button(Self.deleteCloudCopyButtonTitle) {
            Task { await model.deleteCloudCopy() }
          }
          .disabled(!model.canDeleteCloudCopy)
        }
      }
    }
    .onAppear {
      guard model.hasCloudCopyReference, model.versionHistory.isEmpty else { return }
      Task { await model.loadVersionHistory() }
    }
  }

  private func versionRow(_ version: NativeDocumentVersionSummary) -> some View {
    Button {
      Task { await model.previewVersion(version.versionId) }
    } label: {
      HStack(alignment: .top, spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text(Self.versionDisplayTitle(filePath: model.filePath, createdAt: version.createdAt))
            .font(.callout.weight(.semibold))
          Text(Self.versionMetadataLine(operation: version.operation, versionNumber: version.versionNumber))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Spacer()
      }
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        model.selectedVersionId == version.versionId
          ? Color(nsColor: .selectedControlColor).opacity(0.22)
          : Color(nsColor: .controlBackgroundColor),
        in: RoundedRectangle(cornerRadius: 6)
      )
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private var selectedVersionContent: some View {
    if let snapshot = model.selectedVersion {
      VStack(alignment: .leading, spacing: 8) {
        Text(Self.versionDisplayTitle(filePath: model.filePath, createdAt: snapshot.createdAt))
          .font(.callout.weight(.semibold))
        Text(Self.versionMetadataLine(operation: snapshot.operation, versionNumber: snapshot.versionNumber))
          .font(.caption)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
        Text(snapshot.hash)
          .font(.caption2.monospaced())
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
        ScrollView {
          Text(snapshot.markdown.isEmpty ? " " : snapshot.markdown)
            .font(.system(.caption, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .padding(8)
        }
          .frame(minHeight: 180)
          .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        Text(Self.restoreVersionExplanation)
          .font(.caption)
          .foregroundStyle(.secondary)
        TextField(Self.restoreVersionConfirmationPrompt, text: $model.restoreVersionConfirmation)
          .textFieldStyle(.roundedBorder)
        Button(Self.restoreVersionButtonTitle) {
          Task { await model.restoreSelectedVersion() }
        }
        .disabled(!model.canApplySelectedVersionRestore)
      }
    } else if model.selectedVersionId != nil {
      Text("Select a version to preview its Markdown before restoring.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      Text("No version selected.")
        .font(.callout)
        .foregroundStyle(.secondary)
    }
  }

  private var sharingVersionsSubtitle: String {
    if model.hasSharedDocument { return "Sharing is on. Links, collaborators, cloud copy, and versions are managed here." }
    if model.retainedCloudCopyAvailable { return "Sharing is off. Cloud copy and online versions are retained here." }
    if model.filePath != nil { return "Local file. Start sharing to create a cloud copy and online version history." }
    return "Open a Markdown file to manage sharing and versions."
  }

  private func conflictInspectorSummary(_ conflict: MarkLabConflict) -> some View {
    inspectorSection("Conflict") {
      Text(Self.collaborationInspectorConflictSummaryForTesting(hasConflict: true) ?? "")
        .font(.caption)
        .foregroundStyle(.secondary)
      Text("local \(conflict.localHash.prefix(12)) · shared \(conflict.sharedHash.prefix(12)) · base \(conflict.baselineHash.prefix(12))")
        .font(.caption2)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      Button("Review Conflict") {
        collaborationInspectorPresented = false
      }
    }
  }

  private func accessLinkRow(_ link: NativeManagedAccessLink) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(link.role.rawValue.capitalized)
          .font(.callout.weight(.semibold))
        Text(link.status.label)
          .font(.caption)
          .foregroundStyle(link.status == .active ? .green : .secondary)
        Spacer()
        Button("Copy") { model.copyAccessLink(link) }
          .disabled(link.url == nil)
        Button("Revoke") { model.revokeAccessLink(link) }
          .disabled(link.status != .active)
      }
      if let createdAt = link.createdAt {
        Text("Created \(createdAt)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let expiresAt = link.expiresAt {
        Text("Expires \(expiresAt)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let url = link.url {
        Text(url)
          .font(.caption)
          .lineLimit(2)
          .truncationMode(.middle)
          .textSelection(.enabled)
      } else {
        Text("URL unavailable after relaunch; revoke still works.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(8)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
  }

  private func collaboratorRow(_ collaborator: NativeCollaboratorPresence) -> some View {
    HStack(spacing: 8) {
      Circle()
        .fill(Color(nsColor: NSColor(hexString: collaborator.color) ?? .controlAccentColor))
        .frame(width: 10, height: 10)
      VStack(alignment: .leading, spacing: 2) {
        Text(collaborator.name)
          .font(.callout.weight(.semibold))
          .lineLimit(1)
        Text("\(collaborator.roleLabel) · \(collaborator.clientTypeLabel)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
    }
  }

  private var localSyncSummary: String {
    if model.conflict != nil { return "Conflict requires review." }
    if model.hasSharedDocument { return "Projecting shared Markdown to the local file." }
    if model.filePath != nil { return "Local Markdown file." }
    return "No local file."
  }

  private var editorStatusOverlay: some View {
    HStack {
      if let operationalStatus {
        statusPill(
          operationalStatus,
          severity: Self.operationalStatusSeverityForTesting(operationalStatus)
        )
          .frame(maxWidth: 420, alignment: .leading)
      }
      Spacer()
      statusPill(statusSummary)
    }
    .font(.caption)
    .padding(14)
    .allowsHitTesting(false)
  }

  private func statusPill(
    _ text: String,
    severity: MarkEditOperationalStatusSeverity = .normal
  ) -> some View {
    Text(text)
      .lineLimit(1)
      .truncationMode(.middle)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .foregroundStyle(severity == .error ? Color(nsColor: .systemRed) : Color.primary)
      .background(
        severity == .error ? Color(nsColor: .systemRed).opacity(0.14) : Color.clear,
        in: RoundedRectangle(cornerRadius: 6, style: .continuous)
      )
      .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .stroke(
            severity == .error
              ? Color(nsColor: .systemRed).opacity(0.75)
              : Color(nsColor: .separatorColor).opacity(0.6),
            lineWidth: 1
          )
      }
  }

  private var statusSummary: String {
    Self.statusSummaryTextForTesting(
      filePath: model.filePath,
      hasConflict: model.conflict != nil,
      selectionStatus: editorSelectionStatus
    )
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
      if trimmed == "Projected shared Markdown to \(filename)." { return nil }
      if trimmed.hasPrefix("Shared \(filename) as ") { return nil }
    }
    return trimmed
  }

  static func operationalStatusSeverityForTesting(_ statusText: String) -> MarkEditOperationalStatusSeverity {
    let trimmed = statusText.trimmingCharacters(in: .whitespacesAndNewlines)
    let lowercased = trimmed.lowercased()
    if lowercased.hasPrefix("unable ")
      || lowercased.hasPrefix("failed ")
      || lowercased.hasPrefix("conflict:")
      || lowercased.hasPrefix("unavailable")
      || lowercased.hasPrefix("denied")
      || lowercased.contains(" unavailable")
      || lowercased.contains(" denied") {
      return .error
    }
    return .normal
  }

  static func documentSurfaceModeForTesting(hasConflict: Bool) -> MarkEditDocumentSurfaceMode {
    hasConflict ? .conflictReview : .editor
  }

  static func collaborationInspectorConflictSummaryForTesting(hasConflict: Bool) -> String? {
    hasConflict ? "Conflict review is shown in the main editor area." : nil
  }

  static func showsEditorStatusOverlayForTesting(hasConflict: Bool) -> Bool {
    !hasConflict
  }

  static func sharingVersionsInspectorAvailableForTesting(
    filePath: String?,
    hasSharedDocument: Bool,
    hasManagedAccessLinks: Bool,
    hasActiveCollaborators: Bool,
    hasConflict: Bool
  ) -> Bool {
    filePath != nil
      || hasSharedDocument
      || hasManagedAccessLinks
      || hasActiveCollaborators
      || hasConflict
  }

  static func statusSummaryTextForTesting(
    filePath: String?,
    hasConflict: Bool,
    selectionStatus: String
  ) -> String {
    if hasConflict { return "Sync Paused" }
    if filePath != nil { return selectionStatus }
    return "No File"
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
  let openSharedLink: () -> Void
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

private extension NSColor {
  convenience init?(hexString: String) {
    let trimmed = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("#") else { return nil }
    let hex = String(trimmed.dropFirst())
    guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
    self.init(
      red: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1
    )
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

private struct MarkEditConflictReviewView: View {
  @ObservedObject var model: MarkLabAppModel
  let conflict: MarkLabConflict
  @State private var selectedMode: MarkEditConflictReviewMode = .review
  @State private var baseExpanded = false

  var body: some View {
    VStack(spacing: 0) {
      header
        .fixedSize(horizontal: false, vertical: true)
      Divider()
      ScrollView {
        reviewContent
          .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .textBackgroundColor))
      Divider()
      actionBar
        .fixedSize(horizontal: false, vertical: true)
    }
    .background(Color(nsColor: .textBackgroundColor))
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .firstTextBaseline) {
          headerTitle
          Spacer()
          tabPicker
        }
        VStack(alignment: .leading, spacing: 10) {
          headerTitle
          tabPicker
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 20)
    .padding(.vertical, 12)
    .background(conflictReviewChromeBackground)
  }

  private var headerTitle: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(conflictReviewAccent)
        Text("Conflict Review")
          .font(.title3.weight(.semibold))
      }
      Text("local \(conflict.localHash.prefix(12)) · shared \(conflict.sharedHash.prefix(12)) · base \(conflict.baselineHash.prefix(12))")
        .font(.caption)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
    }
  }

  private var tabPicker: some View {
    Picker("Conflict view", selection: $selectedMode) {
      ForEach(MarkEditConflictReviewMode.allCases) { mode in
        Text(mode.label).tag(mode)
      }
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .frame(maxWidth: 300)
  }

  @ViewBuilder
  private var reviewContent: some View {
    switch selectedMode {
    case .review:
      reviewMode
    case .manualMerge:
      resolvedEditor
        .padding(20)
    }
  }

  private var reviewMode: some View {
    VStack(alignment: .leading, spacing: 12) {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 12) {
          codePane(title: "Local disk", detail: String(conflict.localHash.prefix(12)), markdown: conflict.localMarkdown)
          codePane(title: "Shared editor", detail: String(conflict.sharedHash.prefix(12)), markdown: conflict.sharedMarkdown)
        }
        VStack(alignment: .leading, spacing: 12) {
          codePane(title: "Local disk", detail: String(conflict.localHash.prefix(12)), markdown: conflict.localMarkdown)
          codePane(title: "Shared editor", detail: String(conflict.sharedHash.prefix(12)), markdown: conflict.sharedMarkdown)
        }
      }
      codePane(title: "Conflict diff", detail: nil, markdown: conflict.diffPreview, minHeight: 120, maxHeight: 180)
      DisclosureGroup("Show Base", isExpanded: $baseExpanded) {
        codePane(
          title: "Base",
          detail: String(conflict.baselineHash.prefix(12)),
          markdown: conflict.baselineMarkdown,
          minHeight: 120,
          maxHeight: 180
        )
        .padding(.top, 8)
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)
    }
    .padding(20)
  }

  private var resolvedEditor: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .top, spacing: 12) {
        resolvedTextEditor
        codePane(title: "Resolved preview", detail: nil, markdown: model.resolvedConflictMarkdown)
      }
      VStack(alignment: .leading, spacing: 12) {
        resolvedTextEditor
        codePane(title: "Resolved preview", detail: nil, markdown: model.resolvedConflictMarkdown, minHeight: 120)
      }
    }
  }

  private var resolvedTextEditor: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Resolved Markdown")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      TextEditor(text: $model.resolvedConflictMarkdown)
        .font(.system(.caption, design: .monospaced))
        .frame(minHeight: 260)
        .scrollContentBackground(.hidden)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        .overlay {
          RoundedRectangle(cornerRadius: 6)
            .stroke(Color(nsColor: .separatorColor).opacity(0.55), lineWidth: 1)
        }
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }

  private var actionBar: some View {
    ViewThatFits(in: .horizontal) {
      horizontalActionBar
      verticalActionBar
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 12)
    .background(conflictReviewChromeBackground)
  }

  @ViewBuilder
  private var horizontalActionBar: some View {
    switch selectedMode {
    case .review:
      HStack(alignment: .center, spacing: 12) {
        actionBarSummary
        Spacer()
        reviewActionButtons
      }
    case .manualMerge:
      HStack(alignment: .center, spacing: 12) {
        manualMergeConfirmation
        Spacer()
        manualMergeApplyButton
      }
    }
  }

  @ViewBuilder
  private var verticalActionBar: some View {
    switch selectedMode {
    case .review:
      VStack(alignment: .leading, spacing: 10) {
        actionBarSummary
        reviewActionButtons
      }
    case .manualMerge:
      VStack(alignment: .leading, spacing: 10) {
        manualMergeConfirmation
        manualMergeApplyButton
      }
    }
  }

  private var actionBarSummary: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("Resolve before syncing resumes.")
        .font(.caption.weight(.semibold))
      Text("Resolution is guarded against new disk or shared edits.")
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
  }

  private var reviewActionButtons: some View {
    HStack(spacing: 10) {
      Button("Use Shared") { model.keepSharedConflictVersion() }
        .disabled(!model.canResolveConflictThroughSharedEditor)
      Button("Use Local") { model.acceptLocalConflictVersion() }
        .disabled(!model.canResolveConflictThroughSharedEditor)
    }
  }

  private var manualMergeConfirmation: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Confirm manual merge")
        .font(.caption.weight(.semibold))
      TextField("Type APPLY RESOLVED to confirm", text: $model.resolvedConflictConfirmation)
        .textFieldStyle(.roundedBorder)
        .frame(width: 280)
    }
  }

  @ViewBuilder
  private var manualMergeApplyButton: some View {
    if model.canApplyResolvedConflictMarkdown {
      Button("Apply Manual Merge") { model.resolveConflictWithMergedMarkdown() }
        .buttonStyle(.borderedProminent)
    } else {
      Button("Apply Manual Merge") {}
        .buttonStyle(.bordered)
        .disabled(true)
    }
  }

  private var conflictReviewAccent: Color {
    Color(nsColor: .systemOrange)
  }

  private var conflictReviewChromeBackground: Color {
    Color(nsColor: .controlBackgroundColor).opacity(0.74)
  }

  private func codePane(
    title: String,
    detail: String?,
    markdown: String,
    minHeight: CGFloat = 260,
    maxHeight: CGFloat? = nil
  ) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        if let detail {
          Text(detail)
            .font(.caption2.monospaced())
            .foregroundStyle(.tertiary)
            .textSelection(.enabled)
        }
        Spacer()
      }
      ScrollView {
        Text(markdown.isEmpty ? " " : markdown)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(8)
      }
      .frame(minHeight: minHeight, maxHeight: maxHeight)
      .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
      .overlay {
        RoundedRectangle(cornerRadius: 6)
          .stroke(Color(nsColor: .separatorColor).opacity(0.55), lineWidth: 1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}
