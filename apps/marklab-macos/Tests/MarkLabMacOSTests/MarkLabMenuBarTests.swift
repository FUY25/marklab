import AppKit
import Foundation
import Testing
@testable import MarkLabApp
@testable import MarkLabMacOS

@MainActor
struct MarkLabMenuBarTests {
  @Test("menu bar view model renders shared document rows with status and last sync")
  func rendersSharedDocumentRows() {
    let fileURL = URL(fileURLWithPath: "/tmp/shared.md")
    let opened = OpenRecorder()
    let model = MarkLabMenuBarViewModel(
      openDocument: { opened.opened.append($0) },
      now: { Date(timeIntervalSince1970: 1_779_200_120) }
    )

    let rows = model.rows(from: [
      NativeSharedDocumentSession(
        fileURL: fileURL,
        docId: "doc_1",
        branchId: "branch_1",
        status: .synced,
        lastSyncAt: Date(timeIntervalSince1970: 1_779_200_000),
        hasOpenWindow: false
      ),
    ])

    #expect(rows == [
      MarkLabMenuBarDocumentRow(
        id: fileURL.path,
        fileURL: fileURL,
        title: "shared.md",
        statusLabel: "Synced",
        statusSystemImage: "circle.fill",
        lastSyncLabel: "Synced 2m ago"
      ),
    ])

    model.open(rows[0])
    #expect(opened.opened == [fileURL])
  }

  @Test("menu bar view model has an empty state when no documents are shared")
  func rendersEmptyState() {
    let model = MarkLabMenuBarViewModel(openDocument: { _ in }, now: { Date() })
    #expect(model.emptyTitle(for: []) == "No Shared Documents")
  }

  @Test("menu bar status item uses a bundled template logo")
  func loadsBundledTemplateLogo() {
    #expect(MarkLabBrandAssets.statusTemplateURL() != nil)
    let image = MarkLabBrandAssets.statusItemImage()
    #expect(image.isTemplate)
    #expect(image.size == NSSize(width: 18, height: 18))
    #expect(image.accessibilityDescription == "MarkLab")
  }
}

@MainActor
final class OpenRecorder {
  var opened: [URL] = []
}
