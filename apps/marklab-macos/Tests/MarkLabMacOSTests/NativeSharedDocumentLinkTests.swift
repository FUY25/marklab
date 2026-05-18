import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native shared document links")
struct NativeSharedDocumentLinkTests {
  @Test("parses browser edit links and preserves them inside native app deep links")
  func parsesBrowserEditLinksAndDeepLinks() throws {
    let browserURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_main&token=ml_access_edit&mode=edit&filename=note.md"))

    let link = try NativeSharedDocumentLink.parse(browserURL)
    let deepLink = link.nativeDeepLinkURL()
    let reparsed = try NativeSharedDocumentLink.parse(deepLink)
    let appEditorURL = reparsed.appEditorURL(localDocId: "local_1")

    #expect(link.docId == "doc_1")
    #expect(link.branchId == "branch_main")
    #expect(link.token == "ml_access_edit")
    #expect(link.mode == .edit)
    #expect(link.suggestedFilename == "note.md")
    #expect(link.localFilename == "note.md")
    #expect(deepLink.absoluteString.hasPrefix("marklab://join?url="))
    #expect(reparsed == link)
    #expect(appEditorURL.absoluteString == "https://app.example.test/collab?docId=doc_1&branchId=branch_main&token=ml_access_edit&mode=edit&clientKind=app&nativeShell=markedit&localDocId=local_1&filename=note.md")
  }

  @Test("uses safe filename hints for folder-only local joins")
  func safeFilenameHintsForLocalJoins() throws {
    let namedLink = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_1&branchId=branch_main&mode=edit&filename=team-note")
    let unsafeLink = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_2&branchId=branch_main&mode=edit&filename=../secret.md")

    #expect(namedLink.suggestedFilename == "team-note.md")
    #expect(namedLink.localFilename == "team-note.md")
    #expect(unsafeLink.suggestedFilename == nil)
    #expect(unsafeLink.localFilename == "shared-doc_2.md")
  }

  @Test("rejects non-collab URLs and malformed collab links")
  func rejectsUnsupportedLinks() throws {
    #expect(throws: NativeSharedDocumentLinkError.unsupportedURL) {
      _ = try NativeSharedDocumentLink.parse("https://app.example.test/relay/doc_1")
    }
    #expect(throws: NativeSharedDocumentLinkError.missingDocId) {
      _ = try NativeSharedDocumentLink.parse("https://app.example.test/collab?branchId=branch_1&mode=edit")
    }
    #expect(throws: NativeSharedDocumentLinkError.invalidMode) {
      _ = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=owner")
    }
  }
}
