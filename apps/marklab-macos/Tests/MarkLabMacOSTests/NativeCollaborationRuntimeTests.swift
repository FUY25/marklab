import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native collaboration runtime")
struct NativeCollaborationRuntimeTests {
  @Test("persists the refresh token, computes refresh delay, and stops editing after terminal denial")
  func refreshLifecycleStopsAfterTerminalDenial() async throws {
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: """
      {
        "mode": "edit",
        "session": {
          "sessionId": "session_app",
          "clientKind": "app",
          "displayName": "MarkLab.app",
          "refreshToken": "refresh_session_secret"
        },
        "providerToken": {
          "providerDocId": "ml_doc_1",
          "sessionId": "session_app",
          "authorization": "full",
          "validForSeconds": 600,
          "issuedAt": "2026-05-15T12:00:00Z",
          "expiresAt": "2026-05-15T12:10:00Z",
          "clientToken": {
            "docId": "ml_doc_1",
            "url": "ws://api.example.test/d/ml_doc_1/ws/ml_doc_1",
            "baseUrl": "https://api.example.test/d/ml_doc_1",
            "token": "ysweet_initial",
            "authorization": "full"
          }
        }
      }
      """)
    transport.enqueue(json: #"{"error":"grant_revoked"}"#, statusCode: 403)
    let sessionStore = InMemoryNativeEditSessionStore()
    let runtime = NativeCollaborationRuntime(
      fileURL: URL(fileURLWithPath: "/tmp/note.md"),
      sessionClient: NativeCollabSessionClient(apiBaseURL: URL(string: "https://api.example.test")!, transport: transport),
      sessionStore: sessionStore,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )

    _ = try await runtime.startEditSession(docId: "doc_1", branchId: "branch_1", displayName: "MarkLab.app", shareToken: nil)
    #expect(sessionStore.saved?.refreshToken == "refresh_session_secret")
    let now = try #require(ISO8601DateFormatter().date(from: "2026-05-15T12:07:00Z"))
    #expect(runtime.nextRefreshDelaySeconds(now: now) == 60)

    await #expect(throws: NativeHTTPError.httpStatus(403)) {
      _ = try await runtime.refreshProviderToken()
    }
    #expect(runtime.connectionState == .unavailable)
    #expect(sessionStore.saved == nil)
    await #expect(throws: NativeCollabSessionError.invalidProviderTokenRefresh) {
      _ = try await runtime.refreshProviderToken()
    }
  }

  @Test("projects provider changes to disk and ingests one-sided disk changes back to provider")
  func projectsAndIngestsOneSidedChanges() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let provider = RecordingNativeProviderText(markdown: "Base\n")
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let runtime = NativeCollaborationRuntime(
      fileURL: fileURL,
      providerText: provider,
      baselineStore: baselineStore,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )

    try runtime.openSharedDocument()
    try runtime.applyProviderMarkdown("Remote\n")
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Remote\n")

    try Data("Disk\n".utf8).write(to: fileURL)
    let result = try runtime.ingestDiskMarkdown()

    #expect(result == .diskAppliedToProvider)
    #expect(provider.markdown == "Disk\n")
    let storedBaseline = try #require(try baselineStore.loadBaseline(fileURL: fileURL))
    #expect(storedBaseline.lastProjectedMarkdown == "Disk\n")
    #expect(storedBaseline.lastProviderStateFingerprint == NativeProjectionBaselineRecord.providerYTextFingerprint("Disk\n"))
    #expect(provider.appliedDiskTransactions == [
      RecordingNativeProviderText.AppliedDiskTransaction(
        markdown: "Disk\n",
        baseline: "Remote\n",
        origin: "marklab.native.disk"
      ),
    ])
    #expect(runtime.connectionState == .connected)
  }

  @Test("does not advance runtime baseline when durable baseline persistence fails")
  func baselineFailureDoesNotAdvanceRuntimeBaseline() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let provider = RecordingNativeProviderText(markdown: "Base\n")
    let baselineStore = ThrowingNativeProjectionBaselineStore(initial: NativeProjectionBaselineRecord(
      markdown: "Base\n",
      providerStateFingerprint: NativeProjectionBaselineRecord.providerYTextFingerprint("Base\n")
    ))
    let runtime = NativeCollaborationRuntime(
      fileURL: fileURL,
      providerText: provider,
      baselineStore: baselineStore,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )
    try runtime.openSharedDocument()

    #expect(throws: ThrowingNativeProjectionBaselineStore.StoreError.self) {
      try runtime.applyProviderMarkdown("Remote\n")
    }
    let result = try runtime.applyProviderMarkdown("Other remote\n")

    #expect(result == .conflict)
    #expect(runtime.connectionState == .conflict)
  }

  @Test("does not silently overwrite divergent disk edits when provider markdown arrives")
  func providerProjectionRefusesDivergentDiskOverwrite() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let provider = RecordingNativeProviderText(markdown: "Base\n")
    let runtime = NativeCollaborationRuntime(
      fileURL: fileURL,
      providerText: provider,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )

    try runtime.openSharedDocument()
    try Data("Local AI edit\n".utf8).write(to: fileURL)

    let result = try runtime.applyProviderMarkdown("Remote edit\n")

    #expect(result == .conflict)
    #expect(runtime.connectionState == .conflict)
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Local AI edit\n")
  }

  @Test("keeps the projection baseline across reconnect so offline disk and remote provider changes conflict")
  func persistedBaselineSurvivesReconnect() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let provider = RecordingNativeProviderText(markdown: "Base\n")
    let firstRuntime = NativeCollaborationRuntime(
      fileURL: fileURL,
      providerText: provider,
      baselineStore: baselineStore,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )
    try firstRuntime.openSharedDocument()

    try Data("Offline local edit\n".utf8).write(to: fileURL)
    provider.markdown = "Remote while offline\n"
    let reconnectedRuntime = NativeCollaborationRuntime(
      fileURL: fileURL,
      providerText: provider,
      baselineStore: baselineStore,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )

    try reconnectedRuntime.openSharedDocument()
    let result = try reconnectedRuntime.ingestDiskMarkdown()

    #expect(result == .conflict)
    #expect(reconnectedRuntime.connectionState == .conflict)
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Offline local edit\n")
    #expect(provider.markdown == "Remote while offline\n")
  }

  @Test("preserves an empty provider document as a valid remote reconnect change")
  func emptyProviderMarkdownIsNotTreatedAsUnseededOnReconnect() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    try baselineStore.saveBaseline(
      NativeProjectionBaselineRecord(
        markdown: "Base\n",
        providerStateFingerprint: NativeProjectionBaselineRecord.providerYTextFingerprint("Base\n")
      ),
      fileURL: fileURL
    )
    let provider = RecordingNativeProviderText(markdown: "")
    let runtime = NativeCollaborationRuntime(
      fileURL: fileURL,
      providerText: provider,
      baselineStore: baselineStore,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )

    try runtime.openSharedDocument()
    let result = try runtime.ingestDiskMarkdown()

    #expect(result == .providerProjectedToDisk)
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "")
    #expect(provider.markdown == "")
  }

  @Test("stores native projection baselines with hash, provider fingerprint, and timestamp")
  func fileProjectionBaselineStorePersistsFullBaselineTuple() throws {
    let directory = try TemporaryDirectory()
    let storeURL = directory.url.appending(path: "projection-baselines.json")
    let fileURL = directory.url.appending(path: "note.md")
    let store = FileNativeProjectionBaselineStore(fileURL: storeURL)

    try store.saveBaseline(
      NativeProjectionBaselineRecord(markdown: "Projected\n", providerStateFingerprint: "provider:fingerprint"),
      fileURL: fileURL
    )
    let loaded = try #require(try store.loadBaseline(fileURL: fileURL))

    #expect(loaded.lastProjectedMarkdown == "Projected\n")
    #expect(loaded.lastProjectedHash == NativeProjectionBaselineRecord.markdownHash("Projected\n"))
    #expect(loaded.lastProviderStateFingerprint == "provider:fingerprint")
    #expect(!loaded.updatedAt.isEmpty)
  }

  @Test("opens conflict instead of silently applying when disk and provider both changed")
  func detectsBothSidesChangedConflict() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let provider = RecordingNativeProviderText(markdown: "Base\n")
    let runtime = NativeCollaborationRuntime(
      fileURL: fileURL,
      providerText: provider,
      refreshPolicy: NativeProviderTokenRefreshPolicy(refreshMarginSeconds: 120, checkIntervalSeconds: 30)
    )

    try runtime.openSharedDocument()
    provider.markdown = "Remote\n"
    try Data("Disk\n".utf8).write(to: fileURL)

    let result = try runtime.ingestDiskMarkdown()

    #expect(result == .conflict)
    #expect(runtime.connectionState == .conflict)
    #expect(provider.markdown == "Remote\n")
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Disk\n")
  }
}

final class RecordingNativeProviderText: NativeProviderTextAdapter {
  struct AppliedDiskTransaction: Equatable {
    let markdown: String
    let baseline: String
    let origin: String
  }

  var markdown: String
  private(set) var appliedDiskTransactions: [AppliedDiskTransaction] = []

  init(markdown: String) {
    self.markdown = markdown
  }

  func applyDiskMarkdown(_ markdown: String, replacing baseline: String, origin: String) {
    appliedDiskTransactions.append(AppliedDiskTransaction(markdown: markdown, baseline: baseline, origin: origin))
    self.markdown = markdown
  }
}

final class ThrowingNativeProjectionBaselineStore: NativeProjectionBaselineStore {
  enum StoreError: Error {
    case failed
  }

  private let initial: NativeProjectionBaselineRecord?
  private var didLoad = false

  init(initial: NativeProjectionBaselineRecord?) {
    self.initial = initial
  }

  func loadBaseline(fileURL: URL) throws -> NativeProjectionBaselineRecord? {
    if didLoad { return initial }
    didLoad = true
    return initial
  }

  func saveBaseline(_ baseline: NativeProjectionBaselineRecord, fileURL: URL) throws {
    throw StoreError.failed
  }

  func clearBaseline(fileURL: URL) throws {}
}
