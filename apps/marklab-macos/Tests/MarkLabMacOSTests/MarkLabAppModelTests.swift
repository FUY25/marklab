import Foundation
import Testing
@testable import MarkLabApp
@testable import MarkLabMacOS

@Suite("MarkLab app model")
struct MarkLabAppModelTests {
  @MainActor
  @Test("rehydrates persisted conflicts with their shared editor URL")
  func persistedConflictCanResolveAfterReload() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    let conflictStore = NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory))
    let sharedEditorURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&localDocId=local_1"))
    try Data("Local\n".utf8).write(to: fileURL)
    try conflictStore.save(
      MarkLabConflict(
        localMarkdown: "Local\n",
        sharedMarkdown: "Shared\n",
        baselineMarkdown: "Base\n",
        sharedEditorURL: sharedEditorURL
      ),
      fileURL: fileURL
    )
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: conflictStore,
      nativeBearerToken: nil
    )

    model.loadFile(fileURL)

    let normalizedURL = try #require(MarkLabAppModel.markEditNativeShellURL(sharedEditorURL))
    #expect(model.conflict?.sharedEditorURL == normalizedURL)
    #expect(model.embeddedCollabURL == normalizedURL)
    #expect(URLComponents(url: normalizedURL, resolvingAgainstBaseURL: false)?.queryItems?.contains(
      URLQueryItem(name: "nativeShell", value: "markedit")
    ) == true)
    #expect(model.canResolveConflictThroughSharedEditor)
  }

  @MainActor
  @Test("requires pasted resolved Markdown and explicit confirmation before native conflict apply")
  func resolvedConflictRequiresMarkdownAndConfirmation() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    let conflictStore = NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory))
    let sharedEditorURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app"))
    try Data("Local\n".utf8).write(to: fileURL)
    try conflictStore.save(
      MarkLabConflict(
        localMarkdown: "Local\n",
        sharedMarkdown: "Shared\n",
        baselineMarkdown: "Base\n",
        sharedEditorURL: sharedEditorURL
      ),
      fileURL: fileURL
    )
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: conflictStore,
      nativeBearerToken: nil
    )

    model.loadFile(fileURL)
    model.resolvedConflictMarkdown = ""
    model.resolvedConflictConfirmation = "APPLY RESOLVED"
    #expect(!model.canApplyResolvedConflictMarkdown)
    model.resolveConflictWithMergedMarkdown()
    #expect(model.pendingDiskIngestion == nil)
    #expect(model.statusText == "Paste resolved Markdown and type APPLY RESOLVED before applying it.")

    model.resolvedConflictMarkdown = "Merged\n"
    model.resolvedConflictConfirmation = ""
    #expect(!model.canApplyResolvedConflictMarkdown)
    model.resolveConflictWithMergedMarkdown()
    #expect(model.pendingDiskIngestion == nil)

    model.resolvedConflictConfirmation = "APPLY RESOLVED"
    #expect(model.canApplyResolvedConflictMarkdown)
    model.resolveConflictWithMergedMarkdown()

    let pending = try #require(model.pendingDiskIngestion)
    #expect(pending.markdown == "Merged\n")
    #expect(pending.baselineMarkdown == "Shared\n")
  }

  @MainActor
  @Test("native conflict exposes an explicit diff preview before resolution")
  func nativeConflictExposesDiffPreview() throws {
    let conflict = MarkLabConflict(
      localMarkdown: "Title\nLocal only\n",
      sharedMarkdown: "Title\nShared only\n",
      baselineMarkdown: "Title\n"
    )

    #expect(conflict.diffPreview.contains("- Local only"))
    #expect(conflict.diffPreview.contains("+ Shared only"))
  }

  @MainActor
  @Test("does not overwrite disk changes that land during native conflict commit")
  func nativeConflictResolutionDoesNotOverwriteDiskRace() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    let conflictStore = NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory))
    let sharedEditorURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app"))
    try Data("Local conflict\n".utf8).write(to: fileURL)
    try conflictStore.save(
      MarkLabConflict(
        localMarkdown: "Local conflict\n",
        sharedMarkdown: "Shared conflict\n",
        baselineMarkdown: "Base\n",
        sharedEditorURL: sharedEditorURL
      ),
      fileURL: fileURL
    )
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: conflictStore,
      nativeBearerToken: nil,
      beforeDiskIngestionReplace: {
        try? Data("External race\n".utf8).write(to: fileURL)
      }
    )

    model.loadFile(fileURL)
    model.acceptLocalConflictVersion()
    let pending = try #require(model.pendingDiskIngestion)
    model.handleDiskIngestionBridgeResult(
      DiskIngestionBridgeResult(
        revision: pending.revision,
        ok: true,
        markdown: pending.markdown,
        baselineMarkdown: pending.baselineMarkdown,
        providerMarkdown: nil,
        reason: nil
      )
    )

    let diskMarkdown = try String(contentsOf: fileURL, encoding: .utf8)
    #expect(diskMarkdown == "External race\n")
    #expect(model.conflict?.localMarkdown == "External race\n")
    #expect(model.pendingDiskIngestion == nil)
    #expect(model.statusText == "Local file changed again. Review the updated conflict before resolving.")
  }
}
