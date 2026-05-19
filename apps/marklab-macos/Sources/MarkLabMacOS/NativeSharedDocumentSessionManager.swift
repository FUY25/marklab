import Foundation

public enum NativeSharedDocumentSyncStatus: String, Codable, Equatable, Sendable {
  case syncing
  case synced
  case offline
  case conflict
  case error
}

public struct NativeSharedDocumentSession: Codable, Equatable, Identifiable, Sendable {
  public let fileURL: URL
  public let docId: String
  public let branchId: String
  public var status: NativeSharedDocumentSyncStatus
  public var lastSyncAt: Date?
  public var hasOpenWindow: Bool

  public var id: String { fileURL.path }

  public init(
    fileURL: URL,
    docId: String,
    branchId: String,
    status: NativeSharedDocumentSyncStatus,
    lastSyncAt: Date?,
    hasOpenWindow: Bool
  ) {
    self.fileURL = fileURL
    self.docId = docId
    self.branchId = branchId
    self.status = status
    self.lastSyncAt = lastSyncAt
    self.hasOpenWindow = hasOpenWindow
  }
}

@MainActor
public final class NativeSharedDocumentSessionManager {
  public static let shared = NativeSharedDocumentSessionManager()

  public private(set) var sessions: [NativeSharedDocumentSession] = [] {
    didSet { notifyListeners() }
  }

  private var listeners: [UUID: () -> Void] = [:]

  public init() {}

  @discardableResult
  public func addListener(_ listener: @escaping () -> Void) -> UUID {
    let id = UUID()
    listeners[id] = listener
    return id
  }

  public func removeListener(_ id: UUID) {
    listeners[id] = nil
  }

  public func upsertSession(
    fileURL: URL,
    docId: String,
    branchId: String,
    status: NativeSharedDocumentSyncStatus,
    lastSyncAt: Date?
  ) {
    let key = canonicalKey(fileURL)
    let existing = sessions.first { canonicalKey($0.fileURL) == key }
    let next = NativeSharedDocumentSession(
      fileURL: fileURL,
      docId: docId,
      branchId: branchId,
      status: status,
      lastSyncAt: lastSyncAt ?? existing?.lastSyncAt,
      hasOpenWindow: existing?.hasOpenWindow ?? false
    )
    sessions.removeAll { canonicalKey($0.fileURL) == key }
    sessions.append(next)
    sessions.sort { $0.fileURL.lastPathComponent.localizedCaseInsensitiveCompare($1.fileURL.lastPathComponent) == .orderedAscending }
  }

  public func attachWindow(fileURL: URL) {
    update(fileURL: fileURL) { session in
      session.hasOpenWindow = true
    }
  }

  public func detachWindow(fileURL: URL) {
    update(fileURL: fileURL) { session in
      session.hasOpenWindow = false
    }
  }

  public func markSynced(fileURL: URL, at date: Date = Date()) {
    update(fileURL: fileURL) { session in
      session.status = .synced
      session.lastSyncAt = date
    }
  }

  public func markStatus(fileURL: URL, _ status: NativeSharedDocumentSyncStatus) {
    update(fileURL: fileURL) { session in
      session.status = status
    }
  }

  public func removeSession(fileURL: URL) {
    let key = canonicalKey(fileURL)
    sessions.removeAll { canonicalKey($0.fileURL) == key }
  }

  private func update(fileURL: URL, mutate: (inout NativeSharedDocumentSession) -> Void) {
    let key = canonicalKey(fileURL)
    guard let index = sessions.firstIndex(where: { canonicalKey($0.fileURL) == key }) else { return }
    mutate(&sessions[index])
  }

  private func canonicalKey(_ fileURL: URL) -> String {
    NativeLocalDocumentIdentity.canonicalPath(fileURL: fileURL)
  }

  private func notifyListeners() {
    for listener in listeners.values {
      listener()
    }
  }
}
