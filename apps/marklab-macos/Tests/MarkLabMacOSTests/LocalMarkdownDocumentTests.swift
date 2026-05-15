import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Local Markdown document")
struct LocalMarkdownDocumentTests {
  @Test("preserves exact markdown bytes for unshared local editing")
  func preservesExactBytesForUnsharedFiles() throws {
    let directory = try TemporaryDirectory()
    let file = directory.url.appending(path: "note.md")
    let original = Data([0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65, 0x0d, 0x0a])
    try original.write(to: file)

    var document = try LocalMarkdownDocument.open(fileURL: file, shared: false)
    document.replaceText("# Title\r\n\r\nLocal edit.\r\n")
    try document.save()
    let reopened = try LocalMarkdownDocument.open(fileURL: file, shared: false)

    #expect(try Data(contentsOf: file) == Data("# Title\r\n\r\nLocal edit.\r\n".utf8))
    #expect(reopened.text == "# Title\r\n\r\nLocal edit.\r\n")
  }

  @Test("normalizes CRLF to LF only for shared collaboration files")
  func normalizesOnlySharedFiles() throws {
    let directory = try TemporaryDirectory()
    let file = directory.url.appending(path: "shared.md")
    try Data("# Shared\r\n\r\nBody.\r\n".utf8).write(to: file)

    var document = try LocalMarkdownDocument.open(fileURL: file, shared: true)
    document.replaceText("# Shared\r\n\r\nCollaborative edit.\r\n")
    try document.save()

    #expect(try String(contentsOf: file, encoding: .utf8) == "# Shared\n\nCollaborative edit.\n")
  }
}
