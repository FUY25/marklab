import Foundation
import MarkLabMacOS

@MainActor
enum MarkLabSharedSessionRestorer {
  static func restoreActiveSessions(
    bindingStore: NativeSharedDocumentBindingStore = FileNativeSharedDocumentBindingStore.defaultStore(),
    baselineStore: NativeProjectionBaselineStore = FileNativeProjectionBaselineStore.defaultStore(),
    sessionManager: NativeSharedDocumentSessionManager = .shared,
    fileManager: FileManager = .default
  ) {
    guard let bindings = try? bindingStore.loadAllBindings() else { return }
    for binding in bindings where binding.syncEnabled {
      let fileURL = URL(fileURLWithPath: binding.filePath)
      guard fileManager.fileExists(atPath: fileURL.path) else { continue }
      let baseline = try? baselineStore.loadBaseline(fileURL: fileURL)
      sessionManager.upsertSession(
        fileURL: fileURL,
        docId: binding.docId,
        branchId: binding.branchId,
        status: baseline == nil ? .offline : .synced,
        lastSyncAt: baseline.flatMap { ISO8601DateFormatter().date(from: $0.updatedAt) }
      )
    }
  }
}
