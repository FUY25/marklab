import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native conflict store")
struct NativeConflictStoreTests {
  @Test("persists, reloads, and clears conflict state per file")
  func persistsReloadsAndClearsConflictState() throws {
    let directory = try TemporaryDirectory()
    let storeURL = directory.url.appending(path: "conflicts", directoryHint: .isDirectory)
    let fileURL = directory.url.appending(path: "note.md")
    let conflict = MarkLabConflict(
      localMarkdown: "Local\n",
      sharedMarkdown: "Shared\n",
      baselineMarkdown: "Base\n",
      sharedEditorURL: URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&localDocId=local_1")
    )

    try NativeConflictStore(directoryURL: storeURL).save(conflict, fileURL: fileURL)
    let reloadedStore = NativeConflictStore(directoryURL: storeURL)

    #expect(try reloadedStore.load(fileURL: fileURL) == conflict)

    reloadedStore.clear(fileURL: fileURL)

    #expect(try reloadedStore.load(fileURL: fileURL) == nil)
  }
}
