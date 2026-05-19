import Foundation

public enum NativeCLIShareAction: String, Codable, Equatable, Sendable {
  case join
  case share
}

public struct NativeCLIShareRequest: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let requestId: String
  public let action: NativeCLIShareAction
  public let file: String
  public let role: NativeLinkRole
  public let link: String?
  public let createdAt: String

  public init(
    schemaVersion: Int = 1,
    requestId: String,
    action: NativeCLIShareAction,
    file: String,
    role: NativeLinkRole,
    link: String? = nil,
    createdAt: String
  ) {
    self.schemaVersion = schemaVersion
    self.requestId = requestId
    self.action = action
    self.file = file
    self.role = role
    self.link = link
    self.createdAt = createdAt
  }
}

public struct NativeCLIShareResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let requestId: String
  public let action: String?
  public let file: String?
  public let role: NativeLinkRole?
  public let url: String?
  public let copied: Bool
  public let docId: String?
  public let branchId: String?
  public let grantId: String?
  public let opened: Bool
  public let code: String?
  public let message: String?

  public static func success(
    requestId: String,
    file: String,
    role: NativeLinkRole,
    link: NativeHostedShareLink,
    docId: String,
    branchId: String,
    copied: Bool,
    opened: Bool
  ) -> NativeCLIShareResponse {
    NativeCLIShareResponse(
      ok: true,
      requestId: requestId,
      action: "native_share_link_created",
      file: file,
      role: role,
      url: link.url.absoluteString,
      copied: copied,
      docId: docId,
      branchId: branchId,
      grantId: link.grantId,
      opened: opened,
      code: nil,
      message: nil
    )
  }

  public static func joinSuccess(
    requestId: String,
    file: String,
    docId: String,
    branchId: String,
    opened: Bool
  ) -> NativeCLIShareResponse {
    NativeCLIShareResponse(
      ok: true,
      requestId: requestId,
      action: "native_join_started",
      file: file,
      role: .edit,
      url: nil,
      copied: false,
      docId: docId,
      branchId: branchId,
      grantId: nil,
      opened: opened,
      code: nil,
      message: nil
    )
  }

  public static func failure(
    requestId: String,
    code: String,
    message: String
  ) -> NativeCLIShareResponse {
    NativeCLIShareResponse(
      ok: false,
      requestId: requestId,
      action: nil,
      file: nil,
      role: nil,
      url: nil,
      copied: false,
      docId: nil,
      branchId: nil,
      grantId: nil,
      opened: false,
      code: code,
      message: message
    )
  }
}

public protocol NativeCLIShareRequestStore: AnyObject {
  func writeRequest(_ request: NativeCLIShareRequest) throws
  func loadRequest(requestId: String) throws -> NativeCLIShareRequest?
  func pendingRequestIds() throws -> [String]
  func writeResponse(_ response: NativeCLIShareResponse) throws
  func loadResponse(requestId: String) throws -> NativeCLIShareResponse?
}

public final class FileNativeCLIShareRequestStore: NativeCLIShareRequestStore {
  private let appSupportDirectory: URL
  private let fileManager: FileManager
  private let maximumPendingRequestAge: TimeInterval
  private let now: () -> Date
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(
    appSupportDirectory: URL,
    fileManager: FileManager = .default,
    maximumPendingRequestAge: TimeInterval = 600,
    now: @escaping () -> Date = Date.init
  ) {
    self.appSupportDirectory = appSupportDirectory
    self.fileManager = fileManager
    self.maximumPendingRequestAge = maximumPendingRequestAge
    self.now = now
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  }

  public static func defaultStore(
    appSupportDirectory: URL? = nil,
    fileManager: FileManager = .default
  ) -> FileNativeCLIShareRequestStore {
    let appSupport = appSupportDirectory ?? NativeAppSupportDirectory.url(fileManager: fileManager)
    return FileNativeCLIShareRequestStore(appSupportDirectory: appSupport, fileManager: fileManager)
  }

  public func writeRequest(_ request: NativeCLIShareRequest) throws {
    try write(request, to: requestURL(request.requestId))
  }

  public func loadRequest(requestId: String) throws -> NativeCLIShareRequest? {
    try load(NativeCLIShareRequest.self, from: requestURL(requestId))
  }

  public func pendingRequestIds() throws -> [String] {
    let requestsDirectory = appSupportDirectory.appending(path: "cli-requests", directoryHint: .isDirectory)
    guard fileManager.fileExists(atPath: requestsDirectory.path) else { return [] }
    let requestIds = try fileManager
      .contentsOfDirectory(at: requestsDirectory, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "json" }
      .map { $0.deletingPathExtension().lastPathComponent }
      .sorted()
    var pending: [String] = []
    for requestId in requestIds where !fileManager.fileExists(atPath: responseURL(requestId).path) {
      guard let request = try loadRequest(requestId: requestId), !isStale(request) else { continue }
      pending.append(requestId)
    }
    return pending
  }

  public func writeResponse(_ response: NativeCLIShareResponse) throws {
    try write(response, to: responseURL(response.requestId))
  }

  public func loadResponse(requestId: String) throws -> NativeCLIShareResponse? {
    try load(NativeCLIShareResponse.self, from: responseURL(requestId))
  }

  private func requestURL(_ requestId: String) -> URL {
    appSupportDirectory
      .appending(path: "cli-requests", directoryHint: .isDirectory)
      .appending(path: "\(requestId).json", directoryHint: .notDirectory)
  }

  private func responseURL(_ requestId: String) -> URL {
    appSupportDirectory
      .appending(path: "cli-responses", directoryHint: .isDirectory)
      .appending(path: "\(requestId).json", directoryHint: .notDirectory)
  }

  private func write<T: Encodable>(_ value: T, to url: URL) throws {
    try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try encoder.encode(value).write(to: url, options: [.atomic])
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  private func load<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    return try decoder.decode(type, from: Data(contentsOf: url))
  }

  private func isStale(_ request: NativeCLIShareRequest) -> Bool {
    guard maximumPendingRequestAge > 0, let createdAt = Self.date(from: request.createdAt) else { return false }
    return now().timeIntervalSince(createdAt) > maximumPendingRequestAge
  }

  private static func date(from value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
  }
}

public struct NativeCLIShareServiceRequest: Equatable, Sendable {
  public let fileURL: URL
  public let role: NativeLinkRole

  public init(fileURL: URL, role: NativeLinkRole) {
    self.fileURL = fileURL
    self.role = role
  }
}

public struct NativeCLIJoinServiceRequest: Equatable, Sendable {
  public let link: String
  public let fileURL: URL

  public init(link: String, fileURL: URL) {
    self.link = link
    self.fileURL = fileURL
  }
}

public struct NativeCLIShareServiceResult: Equatable, Sendable {
  public let link: NativeHostedShareLink
  public let docId: String
  public let branchId: String
  public let copied: Bool
  public let opened: Bool

  public init(
    link: NativeHostedShareLink,
    docId: String,
    branchId: String,
    copied: Bool,
    opened: Bool
  ) {
    self.link = link
    self.docId = docId
    self.branchId = branchId
    self.copied = copied
    self.opened = opened
  }
}

public struct NativeCLIJoinServiceResult: Equatable, Sendable {
  public let docId: String
  public let branchId: String
  public let opened: Bool

  public init(docId: String, branchId: String, opened: Bool) {
    self.docId = docId
    self.branchId = branchId
    self.opened = opened
  }
}

@MainActor
public protocol NativeCLIShareService: AnyObject {
  func createShareLink(for request: NativeCLIShareServiceRequest) async throws -> NativeCLIShareServiceResult
  func joinSharedDocument(for request: NativeCLIJoinServiceRequest) async throws -> NativeCLIJoinServiceResult
}

public final class NativeCLIShareRequestProcessor {
  private let store: NativeCLIShareRequestStore
  private let shareService: NativeCLIShareService

  public init(store: NativeCLIShareRequestStore, shareService: NativeCLIShareService) {
    self.store = store
    self.shareService = shareService
  }

  @MainActor
  public func process(requestId: String) async throws {
    guard let request = try store.loadRequest(requestId: requestId) else {
      try store.writeResponse(.failure(
        requestId: requestId,
        code: "native_share_failed",
        message: "Native share request was not found."
      ))
      return
    }

    do {
      switch request.action {
      case .share:
        let result = try await shareService.createShareLink(for: NativeCLIShareServiceRequest(
          fileURL: URL(fileURLWithPath: request.file),
          role: request.role
        ))
        try store.writeResponse(.success(
          requestId: request.requestId,
          file: request.file,
          role: request.role,
          link: result.link,
          docId: result.docId,
          branchId: result.branchId,
          copied: result.copied,
          opened: result.opened
        ))
      case .join:
        guard let link = request.link, !link.isEmpty else {
          throw NativeSharedDocumentLinkError.invalidURL
        }
        let result = try await shareService.joinSharedDocument(for: NativeCLIJoinServiceRequest(
          link: link,
          fileURL: URL(fileURLWithPath: request.file)
        ))
        try store.writeResponse(.joinSuccess(
          requestId: request.requestId,
          file: request.file,
          docId: result.docId,
          branchId: result.branchId,
          opened: result.opened
        ))
      }
    } catch {
      try store.writeResponse(.failure(
        requestId: request.requestId,
        code: "native_share_failed",
        message: error.localizedDescription
      ))
      throw error
    }
  }
}

@MainActor
public final class NativeCLIShareRequestPump {
  private let store: NativeCLIShareRequestStore
  private let processor: NativeCLIShareRequestProcessor
  private var inFlight: Set<String> = []

  public init(store: NativeCLIShareRequestStore, processor: NativeCLIShareRequestProcessor) {
    self.store = store
    self.processor = processor
  }

  public func processPendingRequests() async throws {
    for requestId in try store.pendingRequestIds() where !inFlight.contains(requestId) {
      inFlight.insert(requestId)
      defer { inFlight.remove(requestId) }
      do {
        try await processor.process(requestId: requestId)
      } catch {
        // The processor persists a failure response so the CLI can return a typed error.
      }
    }
  }
}
