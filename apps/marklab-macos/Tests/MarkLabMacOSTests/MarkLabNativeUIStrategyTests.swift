import Foundation
import Testing
@testable import MarkLabApp

@Suite("MarkLab native UI strategy")
struct MarkLabNativeUIStrategyTests {
  @Test("uses a MarkEdit-derived document shell with collaboration as a layer")
  func usesMarkEditDerivedDocumentShell() {
    let descriptor = MarkEditShellDescriptor.current

    #expect(descriptor.documentMode == .documentWindow)
    #expect(descriptor.sourceAttribution.contains("Learning resources/MarkEdit/MarkEditMac/Sources/Editor"))
    #expect(descriptor.localEditorMode == .webkitCodeMirror)
    #expect(descriptor.collaborationLayerPlacement == .toolbarStatusInspector)
    #expect(!descriptor.prototypeRootOwnsEditorLayout)
    #expect(descriptor.opensFilesInDocumentWindowController)
    #expect(descriptor.collaborationCommands == [
      .open,
      .save,
      .startSharing,
      .createEditLink,
      .createViewLink,
      .copyLink,
      .revokeLink,
    ])
  }

  @Test("keeps the MarkEdit editor surface primary and collaboration chrome additive")
  func keepsMarkEditEditorSurfacePrimary() {
    let descriptor = MarkEditShellDescriptor.current

    #expect(descriptor.windowChrome == .nativeDocumentToolbar)
    #expect(descriptor.windowSizing == .markEditDefaultDocument)
    #expect(descriptor.editorSurfacePresentation == .edgeToEdgeEditor)
    #expect(descriptor.statusPresentation == .floatingEditorStatusPill)
    #expect(descriptor.collaborationInspectorBehavior == .hiddenUntilToggledOrRequired)
    #expect(descriptor.collaborationToolbarPlacement == .nativeToolbarMenu)
    #expect(descriptor.preservesMarkEditFormattingToolbar)
    #expect(descriptor.fileCommandPlacement == .nativeFileMenuKeyboardShortcut)
    #expect(descriptor.collaborationSurfaceMode == .localEditorForUnsharedFilesVisibleHostedEditorForSharedFiles)
    #expect(descriptor.defaultWindowMetrics == .markEditDefault)
    #expect(descriptor.defaultWindowMetrics.width == 720)
    #expect(descriptor.defaultWindowMetrics.height == 480)
  }

  @Test("bundles a real CodeMirror local editor instead of a textarea")
  @MainActor
  func bundlesCodeMirrorLocalEditor() throws {
    let contract = try MarkEditLocalMarkdownEditorView.bundledEditorContract()

    #expect(contract.htmlContainsCodeMirrorRoot)
    #expect(contract.htmlUsesClassicBundledScript)
    #expect(contract.scriptContainsCodeMirrorRuntime)
    #expect(contract.scriptContainsNativeBridge)
    #expect(contract.scriptContainsSelectionStatusBridge)
    #expect(contract.scriptPostsEditorReady)
    #expect(contract.scriptContainsFormattingCommandBridge)
    #expect(contract.scriptContainsMarkEditMarkdownVisualTheme)
  }

  @Test("keeps CRLF as the local editor line separator for unshared files")
  @MainActor
  func keepsCRLFLineSeparatorForUnsharedFiles() {
    #expect(MarkEditLocalMarkdownEditorView.preferredLineSeparatorForTesting("# Title\r\nBody\r\n") == "\r\n")
    #expect(MarkEditLocalMarkdownEditorView.preferredLineSeparatorForTesting("# Title\nBody\n") == "\n")
    #expect(MarkEditLocalMarkdownEditorView.preferredLineSeparatorForTesting("old\rmac\rfile\r") == "\r")
    #expect(
      MarkEditLocalMarkdownEditorView.markdownFromBridgeForTesting(
        "# Title\nEdited\n",
        lineSeparator: "\r\n"
      ) == "# Title\r\nEdited\r\n"
    )
    #expect(
      MarkEditLocalMarkdownEditorView.markdownFromBridgeForTesting(
        "# Title\r\nEdited\r\n",
        lineSeparator: "\n"
      ) == "# Title\nEdited\n"
    )
    #expect(
      MarkEditLocalMarkdownEditorView.markdownFromBridgeForTesting(
        "a\nb\nc\nd",
        lineSeparator: "\r\n",
        lineEndings: ["\r\n", "\n", "\r"]
      ) == "a\r\nb\nc\rd"
    )
    #expect(
      MarkEditLocalMarkdownEditorView.markdownFromBridgeForTesting(
        "old\nmac\nfile\n",
        lineSeparator: "\r",
        lineEndings: ["\r", "\r", "\r"]
      ) == "old\rmac\rfile\r"
    )
  }

  @Test("launcher opens selected files in MarkEdit document windows")
  @MainActor
  func launcherUsesDocumentWindowOpenMode() {
    let model = MarkLabAppModel(opensSelectedFilesInNewDocumentWindow: true)

    #expect(model.opensSelectedFilesInNewDocumentWindow)
    #expect(model.shouldOpenSelectedFileInNewDocumentWindow)
  }

  @Test("loaded document models open additional files in separate document windows")
  @MainActor
  func loadedDocumentModelsKeepOpenAsNewDocumentWindow() throws {
    let directory = try TemporaryDirectory()
    let file = directory.url.appending(path: "note.md")
    try "# Title\n".write(to: file, atomically: true, encoding: .utf8)
    let model = MarkLabAppModel(opensSelectedFilesInNewDocumentWindow: false)

    #expect(!model.shouldOpenSelectedFileInNewDocumentWindow)
    model.loadFile(file)

    #expect(model.filePath == file.path)
    #expect(model.shouldOpenSelectedFileInNewDocumentWindow)
  }

  @Test("launch arguments can open a Markdown file directly into the editor shell")
  func launchArgumentsOpenMarkdownFile() {
    let markdownURL = URL(fileURLWithPath: "/tmp/README.md")

    #expect(MarkLabLaunchFile.url(from: ["MarkLabApp", markdownURL.path]) == markdownURL)
    #expect(MarkLabLaunchFile.url(from: ["MarkLabApp", "--flag", markdownURL.path]) == markdownURL)
    #expect(MarkLabLaunchFile.url(from: ["MarkLabApp", "/tmp/image.png"]) == nil)
    #expect(MarkLabLaunchFile.url(from: ["MarkLabApp"]) == nil)
  }

  @Test("launch file is consumed once across SwiftUI and fallback launch paths")
  @MainActor
  func launchFileClaimedOnce() {
    let markdownURL = URL(fileURLWithPath: "/tmp/README.md")

    MarkLabLaunchFileCoordinator.resetForTesting()

    #expect(!MarkLabLaunchFileCoordinator.isClaimed(markdownURL))
    #expect(MarkLabLaunchFileCoordinator.claim(markdownURL))
    #expect(MarkLabLaunchFileCoordinator.isClaimed(markdownURL))
    #expect(!MarkLabLaunchFileCoordinator.claim(markdownURL))
  }

  @Test("MarkEdit shell keeps operational status feedback visible without replacing line-column status")
  @MainActor
  func operationalStatusFeedback() {
    #expect(
      MarkEditDocumentShellView.operationalStatusTextForTesting(
        "Editing note.md.",
        filePath: "/tmp/note.md"
      ) == nil
    )
    #expect(
      MarkEditDocumentShellView.operationalStatusTextForTesting(
        "Unable to save Markdown file.",
        filePath: "/tmp/note.md"
      ) == "Unable to save Markdown file."
    )
    #expect(
      MarkEditDocumentShellView.operationalStatusSeverityForTesting(
        "Unable to ingest local disk change."
      ) == .error
    )
    #expect(
      MarkEditDocumentShellView.operationalStatusSeverityForTesting(
        "Waiting to ingest local disk change into the shared editor."
      ) == .normal
    )
    #expect(
      MarkEditDocumentShellView.operationalStatusTextForTesting(
        "Projected shared Markdown to note.md.",
        filePath: "/tmp/note.md"
      ) == nil
    )
    #expect(
      MarkEditDocumentShellView.operationalStatusTextForTesting(
        "Shared note.md as doc_1. App editor connected as workspace user.",
        filePath: "/tmp/note.md"
      ) == nil
    )
    #expect(
      MarkEditDocumentShellView.statusSummaryTextForTesting(
        filePath: "/tmp/note.md",
        hasConflict: false,
        selectionStatus: "Ln 2, Col 4"
      ) == "Ln 2, Col 4"
    )
  }

  @Test("MarkEdit shell exposes real local editor commands for restored toolbar controls")
  func markEditToolbarCommandsAreReal() {
    #expect(MarkEditLocalEditorCommandAction.heading(2).javascriptPayload.contains(#""heading""#))
    #expect(MarkEditLocalEditorCommandAction.heading(6).javascriptPayload.contains(#""level":6"#))
    #expect(MarkEditLocalEditorCommandAction.bold.javascriptPayload.contains(#""bold""#))
    #expect(MarkEditLocalEditorCommandAction.orderedList.javascriptPayload.contains(#""orderedList""#))
  }

  @Test("hosted MarkEdit shell editor commands and editability require bridge acknowledgements")
  @MainActor
  func hostedEditorBridgeRequiresAcknowledgements() {
    let command = MarkEditLocalEditorCommand(sequence: 1, action: .bold)
    let commandJavaScript = HostedCollabWebView.editorCommandJavaScriptForTesting(command)
    let readOnlyJavaScript = HostedCollabWebView.nativeEditableJavaScriptForTesting(false)

    #expect(commandJavaScript.contains("typeof window.__marklabRunEditorCommand === 'function'"))
    #expect(commandJavaScript.contains(#""bold""#))
    #expect(commandJavaScript.contains("=== true"))
    #expect(readOnlyJavaScript.contains("typeof window.__marklabSetNativeEditable === 'function'"))
    #expect(readOnlyJavaScript.contains("__marklabSetNativeEditable(false) === true"))
  }

  @Test("native conflict review uses the main editor surface instead of the collaboration inspector")
  @MainActor
  func conflictReviewUsesMainEditorSurface() {
    #expect(MarkEditDocumentShellView.documentSurfaceModeForTesting(hasConflict: true) == .conflictReview)
    #expect(MarkEditDocumentShellView.documentSurfaceModeForTesting(hasConflict: false) == .editor)
    #expect(
      MarkEditDocumentShellView.collaborationInspectorConflictSummaryForTesting(hasConflict: true)
        == "Conflict review is shown in the main editor area."
    )
    #expect(MarkEditDocumentShellView.collaborationInspectorConflictSummaryForTesting(hasConflict: false) == nil)
    #expect(!MarkEditDocumentShellView.showsEditorStatusOverlayForTesting(hasConflict: true))
    #expect(MarkEditDocumentShellView.showsEditorStatusOverlayForTesting(hasConflict: false))
    #expect(MarkEditConflictReviewMode.allCases.map(\.label) == ["Review", "Manual Merge"])
  }

  @Test("hosted app web view native marker is independent from bearer auth injection")
  @MainActor
  func hostedAppWebViewNativeMarkerDoesNotRequireBearerToken() {
    let markerJavaScript = HostedCollabWebView.nativeMarkerUserScriptForTesting()
    let authJavaScript = HostedCollabWebView.authFetchUserScriptForTesting("ml_user_session")

    #expect(markerJavaScript.contains("window.__marklabNativeApp = true"))
    #expect(!markerJavaScript.contains("Authorization"))
    #expect(!markerJavaScript.contains("ml_user_session"))
    #expect(authJavaScript.contains("headers.set('Authorization'"))
    #expect(authJavaScript.contains("headers.set('X-MarkLab-Native-App', '1')"))
  }

  @Test("native collaboration inspector models collaborators separately from access links")
  func collaborationInspectorSeparatesPresenceFromLinks() {
    let collaborator = NativeCollaboratorPresence.fromBridgePayload([
      "clientId": 42,
      "name": "Guest",
      "color": "#0891b2",
      "colorLight": "#cffafe",
      "kind": "human",
      "clientKind": "browser",
    ])

    #expect(collaborator?.name == "Guest")
    #expect(collaborator?.clientTypeLabel == "Browser")
    #expect(collaborator?.roleLabel == "Edit")
  }

  @Test("sharing and versions labels explain retained cloud copy")
  @MainActor
  func sharingAndVersionsLabelsExplainRetainedCloudCopy() {
    #expect(MarkEditDocumentShellView.sharingAndVersionsLabel == "Sharing & Versions")
    #expect(MarkEditDocumentShellView.showSharingAndVersionsLabel == "Show Sharing & Versions")
    #expect(
      MarkEditDocumentShellView.stopSharingHelpText
        == "Stops sync and revokes active links. Cloud copy and version history are kept."
    )
    #expect(MarkEditDocumentShellView.cloudCopySectionTitle == "Cloud Copy")
    #expect(MarkEditDocumentShellView.versionHistorySectionTitle == "Version History")
    #expect(MarkEditDocumentShellView.saveVersionButtonTitle == "Save Checkpoint")
    #expect(MarkEditDocumentShellView.restoreVersionButtonTitle == "Restore This Version")
    #expect(MarkEditDocumentShellView.restoreVersionConfirmationPrompt == "Type RESTORE to confirm")
    #expect(
      MarkEditDocumentShellView.restoreVersionExplanation
        == "Restoring creates a new current rollback version. Old snapshots stay in version history, and the local Markdown file updates through normal shared projection."
    )
    #expect(
      MarkEditDocumentShellView.deleteCloudCopySummary
        == "Deletes the hosted copy, online version history, access links, and active cloud sessions. The local Markdown file stays on disk."
    )
    #expect(MarkEditDocumentShellView.deleteCloudCopyButtonTitle == "Delete Cloud Copy")
    #expect(MarkEditDocumentShellView.deleteCloudCopyConfirmationPrompt == "Type DELETE CLOUD COPY to confirm")
    #expect(
      MarkEditDocumentShellView.cloudCopyRetentionSummary
        == "Cloud copy and online version history are kept after Stop Sharing."
    )
    #expect(MarkEditSharingVersionsInspectorMode.allCases.map(\.label) == ["Sharing", "Versions"])
    #expect(MarkEditDocumentShellView.sharingToolbarIconNameForTesting(hasSharedDocument: false) == "link")
    #expect(MarkEditDocumentShellView.sharingToolbarIconNameForTesting(hasSharedDocument: true) == "link")
    #expect(!MarkEditDocumentShellView.sharingToolbarUsesActiveTintForTesting(hasSharedDocument: false))
    #expect(MarkEditDocumentShellView.sharingToolbarUsesActiveTintForTesting(hasSharedDocument: true))
    #expect(MarkEditDocumentShellView.sharingToolbarBackgroundOpacityForTesting(hasSharedDocument: false) == 0)
    #expect(MarkEditDocumentShellView.sharingToolbarBackgroundOpacityForTesting(hasSharedDocument: true) == 0.12)
    #expect(
      MarkEditDocumentShellView.sharingVersionsInspectorAvailableForTesting(
        filePath: "/tmp/note.md",
        hasSharedDocument: false,
        hasManagedAccessLinks: false,
        hasActiveCollaborators: false,
        hasConflict: false
      )
    )
    #expect(
      !MarkEditDocumentShellView.sharingVersionsInspectorAvailableForTesting(
        filePath: nil,
        hasSharedDocument: false,
        hasManagedAccessLinks: false,
        hasActiveCollaborators: false,
        hasConflict: false
      )
    )
  }

  @Test("version rows use filename timestamp and checkpoint labels")
  @MainActor
  func versionRowsUseFilenameTimestampAndCheckpointLabels() {
    let utc = TimeZone(identifier: "UTC")!

    #expect(
      MarkEditDocumentShellView.versionDisplayTitleForTesting(
        filePath: "/tmp/version-ui.md",
        createdAt: "2026-05-22T05:29:55.625Z",
        timeZone: utc
      ) == "version-ui.md - 2026-05-22 05:29 UTC"
    )
    #expect(
      MarkEditDocumentShellView.versionDisplayTitleForTesting(
        filePath: nil,
        createdAt: "not-a-date",
        timeZone: utc
      ) == "Markdown document - not-a-date"
    )
    #expect(MarkEditDocumentShellView.versionOperationLabelForTesting(.autosave) == "Auto checkpoint")
    #expect(MarkEditDocumentShellView.versionOperationLabelForTesting(.manualSave) == "Manual checkpoint")
    #expect(MarkEditDocumentShellView.versionOperationLabelForTesting(.rollback) == "Rollback checkpoint")
    #expect(MarkEditDocumentShellView.versionMetadataLineForTesting(operation: .manualSave, versionNumber: 3) == "Manual checkpoint · #3")
  }

  @Test("local autosave belongs to app settings")
  func localAutosaveBelongsToAppSettings() {
    #expect(MarkLabAppSettings.localAutosaveLabel == "Autosave Local Files")
    #expect(MarkLabAppSettings.localAutosaveEnabledDefaultsKey == "MarkLabLocalAutosaveEnabled")
    #expect(MarkLabAppSettings.localAutosaveDescription == "Only applies when a file is not sharing. Shared documents sync automatically and create online version checkpoints.")
    #expect(MarkLabAppSettings.accountSectionTitle == "Account")
    #expect(MarkLabAppSettings.accountSignedOutDescription == "Sign in before sharing or opening shared documents in MarkLab.app.")
    #expect(MarkLabAppSettings.signInLabel == "Sign In")
    #expect(MarkLabAppSettings.signOutLabel == "Sign Out")
  }

  @Test("MarkEdit shell table of contents follows MarkEdit heading behavior")
  @MainActor
  func tableOfContentsHeadingBehavior() {
    let headings = MarkEditDocumentShellView.markdownHeadingsForTesting(
      """
      # ATX

      Setext One
      ==========

          # Code
          ```
          # Indented Fence Code
          ```
      ## ATX Two ##
      \t# Tab Code
      ````markdown
      # Fenced Code
      ```
      # Still Fenced Code
      ````
      # ATX Three
      Setext Two\r----------\r
      """
    )

    #expect(headings.map(\.title) == ["ATX", "Setext One", "ATX Two", "ATX Three", "Setext Two"])
    #expect(headings.map(\.level) == [1, 1, 2, 1, 2])
  }
}
