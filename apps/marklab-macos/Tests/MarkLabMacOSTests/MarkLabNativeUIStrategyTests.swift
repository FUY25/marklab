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
      .restoreLatestVersion,
    ])
  }

  @Test("bundles a real CodeMirror local editor instead of a textarea")
  @MainActor
  func bundlesCodeMirrorLocalEditor() throws {
    let contract = try MarkEditLocalMarkdownEditorView.bundledEditorContract()

    #expect(contract.htmlContainsCodeMirrorRoot)
    #expect(contract.scriptContainsCodeMirrorRuntime)
    #expect(contract.scriptContainsNativeBridge)
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
}
