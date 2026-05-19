import Foundation
import Testing
@testable import MarkLabMacOS

@MainActor
struct NativeSharedDocumentSessionManagerTests {
  @Test("shared document sessions survive document-window detach")
  func sessionsSurviveWindowDetach() {
    let manager = NativeSharedDocumentSessionManager()
    let fileURL = URL(fileURLWithPath: "/tmp/shared.md")

    manager.upsertSession(
      fileURL: fileURL,
      docId: "doc_1",
      branchId: "branch_1",
      status: .syncing,
      lastSyncAt: nil
    )
    manager.attachWindow(fileURL: fileURL)
    manager.detachWindow(fileURL: fileURL)

    let session = manager.sessions.first
    #expect(session?.fileURL == fileURL)
    #expect(session?.status == .syncing)
    #expect(session?.hasOpenWindow == false)
  }

  @Test("shared document session status and last sync are tracked for menu bar display")
  func tracksStatusAndLastSync() {
    let manager = NativeSharedDocumentSessionManager()
    let fileURL = URL(fileURLWithPath: "/tmp/shared.md")
    let syncedAt = Date(timeIntervalSince1970: 1_779_200_000)

    manager.upsertSession(
      fileURL: fileURL,
      docId: "doc_1",
      branchId: "branch_1",
      status: .syncing,
      lastSyncAt: nil
    )
    manager.markSynced(fileURL: fileURL, at: syncedAt)

    #expect(manager.sessions == [
      NativeSharedDocumentSession(
        fileURL: fileURL,
        docId: "doc_1",
        branchId: "branch_1",
        status: .synced,
        lastSyncAt: syncedAt,
        hasOpenWindow: false
      ),
    ])
  }

  @Test("failed share setup removes pending menu-bar session")
  func failedShareSetupRemovesPendingSession() {
    let manager = NativeSharedDocumentSessionManager()
    let fileURL = URL(fileURLWithPath: "/tmp/failed.md")
    manager.upsertSession(
      fileURL: fileURL,
      docId: "pending",
      branchId: "pending",
      status: .syncing,
      lastSyncAt: nil
    )

    manager.removeSession(fileURL: fileURL)

    #expect(manager.sessions.isEmpty)
  }
}
