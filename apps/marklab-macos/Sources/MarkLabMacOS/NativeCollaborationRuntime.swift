import CryptoKit
import Foundation

public struct NativeProviderTokenRefreshPolicy: Equatable, Sendable {
  public let refreshMarginSeconds: TimeInterval
  public let checkIntervalSeconds: TimeInterval

  public init(refreshMarginSeconds: TimeInterval, checkIntervalSeconds: TimeInterval) {
    self.refreshMarginSeconds = refreshMarginSeconds
    self.checkIntervalSeconds = checkIntervalSeconds
  }
}

public enum NativeCollaborationConnectionState: Equatable {
  case localOnly
  case connected
  case refreshing
  case unavailable
  case conflict
}

public enum NativeDiskIngestionResult: Equatable {
  case noChange
  case diskAppliedToProvider
  case providerProjectedToDisk
  case conflict
}

public protocol NativeProviderTextAdapter: AnyObject {
  var markdown: String { get set }
  func applyDiskMarkdown(_ markdown: String, replacing baseline: String, origin: String)
}

public extension NativeProviderTextAdapter {
  func applyDiskMarkdown(_ markdown: String, replacing baseline: String, origin: String) {
    self.markdown = markdown
  }
}

public protocol NativeEditSessionStore: AnyObject {
  func save(_ session: ActiveNativeEditSession) throws
  func clear() throws
}

public final class InMemoryNativeEditSessionStore: NativeEditSessionStore {
  public private(set) var saved: ActiveNativeEditSession?

  public init() {}

  public func save(_ session: ActiveNativeEditSession) throws {
    saved = session
  }

  public func clear() throws {
    saved = nil
  }
}

public struct NativeProjectionBaselineRecord: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let lastProjectedMarkdown: String
  public let lastProjectedHash: String
  public let lastProviderStateFingerprint: String
  public let updatedAt: String

  public init(
    markdown: String,
    providerStateFingerprint: String,
    updatedAt: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.schemaVersion = 1
    self.lastProjectedMarkdown = markdown
    self.lastProjectedHash = Self.markdownHash(markdown)
    self.lastProviderStateFingerprint = providerStateFingerprint
    self.updatedAt = updatedAt
  }

  public static func providerYTextFingerprint(_ markdown: String) -> String {
    "provider-ytext:\(markdownHash(markdown))"
  }

  public static func markdownHash(_ markdown: String) -> String {
    let digest = SHA256.hash(data: Data(markdown.utf8))
    return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
  }
}

public protocol NativeProjectionBaselineStore: AnyObject {
  func loadBaseline(fileURL: URL) throws -> NativeProjectionBaselineRecord?
  func loadAllBaselines() throws -> [String: NativeProjectionBaselineRecord]
  func saveBaseline(_ baseline: NativeProjectionBaselineRecord, fileURL: URL) throws
  func clearBaseline(fileURL: URL) throws
}

public extension NativeProjectionBaselineStore {
  func loadAllBaselines() throws -> [String: NativeProjectionBaselineRecord] {
    [:]
  }
}

public final class InMemoryNativeProjectionBaselineStore: NativeProjectionBaselineStore {
  private var baselines: [String: NativeProjectionBaselineRecord] = [:]

  public init() {}

  public func loadBaseline(fileURL: URL) throws -> NativeProjectionBaselineRecord? {
    baselines[fileURL.path]
  }

  public func loadAllBaselines() throws -> [String: NativeProjectionBaselineRecord] {
    baselines
  }

  public func saveBaseline(_ baseline: NativeProjectionBaselineRecord, fileURL: URL) throws {
    baselines[fileURL.path] = baseline
  }

  public func clearBaseline(fileURL: URL) throws {
    baselines.removeValue(forKey: fileURL.path)
  }
}

public final class FileNativeProjectionBaselineStore: NativeProjectionBaselineStore {
  private struct StoreFile: Codable {
    var schemaVersion: Int
    var baselines: [String: NativeProjectionBaselineRecord]
  }

  private let fileURL: URL
  private let fileManager: FileManager

  public init(fileURL: URL, fileManager: FileManager = .default) {
    self.fileURL = fileURL
    self.fileManager = fileManager
  }

  public static func defaultStore(
    appSupportDirectory: URL? = nil,
    fileManager: FileManager = .default
  ) -> FileNativeProjectionBaselineStore {
    let appSupport = appSupportDirectory ?? NativeAppSupportDirectory.url(fileManager: fileManager)
    return FileNativeProjectionBaselineStore(fileURL: appSupport.appending(path: "projection-baselines.json"), fileManager: fileManager)
  }

  public func loadBaseline(fileURL documentURL: URL) throws -> NativeProjectionBaselineRecord? {
    try loadStore().baselines[documentURL.path]
  }

  public func loadAllBaselines() throws -> [String: NativeProjectionBaselineRecord] {
    try loadStore().baselines
  }

  public func saveBaseline(_ baseline: NativeProjectionBaselineRecord, fileURL documentURL: URL) throws {
    var store = try loadStore()
    store.baselines[documentURL.path] = baseline
    try saveStore(store)
  }

  public func clearBaseline(fileURL documentURL: URL) throws {
    var store = try loadStore()
    store.baselines.removeValue(forKey: documentURL.path)
    try saveStore(store)
  }

  private func loadStore() throws -> StoreFile {
    guard fileManager.fileExists(atPath: fileURL.path) else {
      return StoreFile(schemaVersion: 1, baselines: [:])
    }
    let data = try Data(contentsOf: fileURL)
    return try JSONDecoder().decode(StoreFile.self, from: data)
  }

  private func saveStore(_ store: StoreFile) throws {
    try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(store)
    try data.write(to: fileURL, options: [.atomic])
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
  }
}

public final class NativeCollaborationRuntime {
  public private(set) var connectionState: NativeCollaborationConnectionState = .localOnly

  private let fileURL: URL
  private let sessionClient: NativeCollabSessionClient?
  private let sessionStore: NativeEditSessionStore
  private let baselineStore: NativeProjectionBaselineStore
  private let refreshPolicy: NativeProviderTokenRefreshPolicy
  private weak var providerText: NativeProviderTextAdapter?
  private var document: LocalMarkdownDocument?
  private var activeSession: ActiveNativeEditSession?
  private var lastProjectedMarkdown: String?

  public init(
    fileURL: URL,
    sessionClient: NativeCollabSessionClient? = nil,
    providerText: NativeProviderTextAdapter? = nil,
    sessionStore: NativeEditSessionStore = InMemoryNativeEditSessionStore(),
    baselineStore: NativeProjectionBaselineStore = InMemoryNativeProjectionBaselineStore(),
    refreshPolicy: NativeProviderTokenRefreshPolicy
  ) {
    self.fileURL = fileURL
    self.sessionClient = sessionClient
    self.providerText = providerText
    self.sessionStore = sessionStore
    self.baselineStore = baselineStore
    self.refreshPolicy = refreshPolicy
  }

  public func openSharedDocument() throws {
    let opened = try LocalMarkdownDocument.open(fileURL: fileURL, shared: true)
    document = opened
    let currentDiskMarkdown = opened.markdownForSave()
    let storedBaseline = try baselineStore.loadBaseline(fileURL: fileURL)
    let baseline = storedBaseline?.lastProjectedMarkdown ?? currentDiskMarkdown
    lastProjectedMarkdown = baseline
    if storedBaseline == nil {
      try baselineStore.saveBaseline(
        NativeProjectionBaselineRecord(
          markdown: baseline,
          providerStateFingerprint: NativeProjectionBaselineRecord.providerYTextFingerprint(baseline)
        ),
        fileURL: fileURL
      )
    }
    if storedBaseline == nil && providerText?.markdown.isEmpty == true {
      providerText?.markdown = currentDiskMarkdown
    }
    connectionState = .connected
  }

  @discardableResult
  public func startEditSession(
    docId: String,
    branchId: String,
    displayName: String,
    shareToken: String?
  ) async throws -> ActiveNativeEditSession {
    guard let sessionClient else { throw NativeCollabSessionError.invalidEditSessionResponse }
    let session = try await sessionClient.createEditSession(
      docId: docId,
      branchId: branchId,
      displayName: displayName,
      shareToken: shareToken
    )
    activeSession = session
    try sessionStore.save(session)
    connectionState = .connected
    return session
  }

  public func nextRefreshDelaySeconds(now: Date = Date()) -> TimeInterval? {
    guard let expiresAt = activeSession?.providerToken?.expiresAt else { return nil }
    guard let expiresAtDate = ISO8601DateFormatter().date(from: expiresAt) else { return nil }
    let refreshAt = expiresAtDate.addingTimeInterval(-refreshPolicy.refreshMarginSeconds)
    return max(0, refreshAt.timeIntervalSince(now))
  }

  @discardableResult
  public func refreshProviderToken() async throws -> IssuedNativeProviderToken {
    guard let sessionClient, let activeSession else { throw NativeCollabSessionError.invalidProviderTokenRefresh }
    connectionState = .refreshing
    do {
      let token = try await sessionClient.refreshProviderToken(activeSession)
      self.activeSession = ActiveNativeEditSession(
        docId: activeSession.docId,
        branchId: activeSession.branchId,
        sessionId: activeSession.sessionId,
        refreshToken: activeSession.refreshToken,
        providerDocId: activeSession.providerDocId,
        providerToken: token
      )
      if let updatedSession = self.activeSession {
        try sessionStore.save(updatedSession)
      }
      connectionState = .connected
      return token
    } catch NativeHTTPError.httpStatus(let status) where (400..<500).contains(status) {
      connectionState = .unavailable
      self.activeSession = nil
      try? sessionStore.clear()
      throw NativeHTTPError.httpStatus(status)
    } catch {
      connectionState = .connected
      throw error
    }
  }

  @discardableResult
  public func applyProviderMarkdown(_ markdown: String) throws -> NativeDiskIngestionResult {
    guard let baseline = lastProjectedMarkdown else { return .noChange }
    let diskDocument = try LocalMarkdownDocument.open(fileURL: fileURL, shared: true)
    let diskMarkdown = diskDocument.markdownForSave()
    let diskChanged = diskMarkdown != baseline
    let providerChanged = markdown != baseline

    if diskChanged && providerChanged && diskMarkdown != markdown {
      connectionState = .conflict
      return .conflict
    }
    guard providerChanged || diskMarkdown != markdown else {
      return .noChange
    }

    var currentDocument = diskDocument
    currentDocument.replaceText(markdown)
    let saved = try currentDocument.saveIfCurrentMarkdownMatches(diskMarkdown)
    guard saved else {
      connectionState = .conflict
      return .conflict
    }
    document = currentDocument
    let projectedMarkdown = currentDocument.markdownForSave()
    try baselineStore.saveBaseline(
      NativeProjectionBaselineRecord(
        markdown: projectedMarkdown,
        providerStateFingerprint: NativeProjectionBaselineRecord.providerYTextFingerprint(markdown)
      ),
      fileURL: fileURL
    )
    lastProjectedMarkdown = projectedMarkdown
    providerText?.markdown = markdown
    connectionState = .connected
    return .providerProjectedToDisk
  }

  public func ingestDiskMarkdown() throws -> NativeDiskIngestionResult {
    guard let baseline = lastProjectedMarkdown else { return .noChange }
    guard let providerText else { return .noChange }
    let diskDocument = try LocalMarkdownDocument.open(fileURL: fileURL, shared: true)
    let diskMarkdown = diskDocument.markdownForSave()
    let providerMarkdown = providerText.markdown
    let diskChanged = diskMarkdown != baseline
    let providerChanged = providerMarkdown != baseline

    if !diskChanged && !providerChanged { return .noChange }
    if diskChanged && !providerChanged {
      providerText.applyDiskMarkdown(diskMarkdown, replacing: baseline, origin: "marklab.native.disk")
      document = diskDocument
      try baselineStore.saveBaseline(
        NativeProjectionBaselineRecord(
          markdown: diskMarkdown,
          providerStateFingerprint: NativeProjectionBaselineRecord.providerYTextFingerprint(diskMarkdown)
        ),
        fileURL: fileURL
      )
      lastProjectedMarkdown = diskMarkdown
      connectionState = .connected
      return .diskAppliedToProvider
    }
    if providerChanged && !diskChanged {
      return try applyProviderMarkdown(providerMarkdown)
    }

    connectionState = .conflict
    return .conflict
  }
}
