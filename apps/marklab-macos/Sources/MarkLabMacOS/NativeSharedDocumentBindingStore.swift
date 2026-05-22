import Foundation

public struct NativeSharedDocumentBinding: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let filePath: String
  public let docId: String
  public let branchId: String
  public let mode: NativeSharedDocumentLinkMode
  public let token: String?
  public let appEditorURL: URL
  public let localDocId: String
  public let baselineHash: String
  public let syncEnabled: Bool
  public let createdAt: String
  public let updatedAt: String

  public init(
    fileURL: URL,
    link: NativeSharedDocumentLink,
    appEditorURL: URL,
    baselineMarkdown: String,
    createdAt: String = ISO8601DateFormatter().string(from: Date()),
    updatedAt: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.schemaVersion = 1
    self.filePath = NativeLocalDocumentIdentity.canonicalPath(fileURL: fileURL)
    self.docId = link.docId
    self.branchId = link.branchId
    self.mode = link.mode
    self.token = link.token
    self.appEditorURL = appEditorURL
    self.localDocId = NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)
    self.baselineHash = NativeProjectionBaselineRecord.markdownHash(baselineMarkdown)
    self.syncEnabled = true
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  public init(
    fileURL: URL,
    document: NativeHostedDocument,
    appEditorURL: URL,
    baselineMarkdown: String,
    createdAt: String = ISO8601DateFormatter().string(from: Date()),
    updatedAt: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.schemaVersion = 1
    self.filePath = NativeLocalDocumentIdentity.canonicalPath(fileURL: fileURL)
    self.docId = document.docId
    self.branchId = document.branchId
    self.mode = .edit
    self.token = nil
    self.appEditorURL = appEditorURL
    self.localDocId = NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)
    self.baselineHash = NativeProjectionBaselineRecord.markdownHash(baselineMarkdown)
    self.syncEnabled = true
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  public func matches(_ link: NativeSharedDocumentLink) -> Bool {
    docId == link.docId && branchId == link.branchId && mode == link.mode
  }

  public func withSyncEnabled(
    _ enabled: Bool,
    updatedAt: String = ISO8601DateFormatter().string(from: Date())
  ) -> NativeSharedDocumentBinding {
    NativeSharedDocumentBinding(
      schemaVersion: schemaVersion,
      filePath: filePath,
      docId: docId,
      branchId: branchId,
      mode: mode,
      token: token,
      appEditorURL: appEditorURL,
      localDocId: localDocId,
      baselineHash: baselineHash,
      syncEnabled: enabled,
      createdAt: createdAt,
      updatedAt: updatedAt
    )
  }

  private init(
    schemaVersion: Int,
    filePath: String,
    docId: String,
    branchId: String,
    mode: NativeSharedDocumentLinkMode,
    token: String?,
    appEditorURL: URL,
    localDocId: String,
    baselineHash: String,
    syncEnabled: Bool,
    createdAt: String,
    updatedAt: String
  ) {
    self.schemaVersion = schemaVersion
    self.filePath = filePath
    self.docId = docId
    self.branchId = branchId
    self.mode = mode
    self.token = token
    self.appEditorURL = appEditorURL
    self.localDocId = localDocId
    self.baselineHash = baselineHash
    self.syncEnabled = syncEnabled
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  private enum CodingKeys: String, CodingKey {
    case schemaVersion
    case filePath
    case docId
    case branchId
    case mode
    case token
    case appEditorURL
    case localDocId
    case baselineHash
    case syncEnabled
    case createdAt
    case updatedAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    filePath = try container.decode(String.self, forKey: .filePath)
    docId = try container.decode(String.self, forKey: .docId)
    branchId = try container.decode(String.self, forKey: .branchId)
    mode = try container.decode(NativeSharedDocumentLinkMode.self, forKey: .mode)
    token = try container.decodeIfPresent(String.self, forKey: .token)
    appEditorURL = try container.decode(URL.self, forKey: .appEditorURL)
    localDocId = try container.decode(String.self, forKey: .localDocId)
    baselineHash = try container.decode(String.self, forKey: .baselineHash)
    syncEnabled = try container.decodeIfPresent(Bool.self, forKey: .syncEnabled) ?? true
    createdAt = try container.decode(String.self, forKey: .createdAt)
    updatedAt = try container.decode(String.self, forKey: .updatedAt)
  }
}

public protocol NativeSharedDocumentBindingStore: AnyObject {
  func loadBinding(fileURL: URL) throws -> NativeSharedDocumentBinding?
  func saveBinding(_ binding: NativeSharedDocumentBinding, fileURL: URL) throws
  func clearBinding(fileURL: URL) throws
}

public final class InMemoryNativeSharedDocumentBindingStore: NativeSharedDocumentBindingStore {
  private var bindings: [String: NativeSharedDocumentBinding] = [:]

  public init() {}

  public func loadBinding(fileURL: URL) throws -> NativeSharedDocumentBinding? {
    bindings[NativeLocalDocumentIdentity.canonicalPath(fileURL: fileURL)]
  }

  public func saveBinding(_ binding: NativeSharedDocumentBinding, fileURL: URL) throws {
    bindings[NativeLocalDocumentIdentity.canonicalPath(fileURL: fileURL)] = binding
  }

  public func clearBinding(fileURL: URL) throws {
    bindings.removeValue(forKey: NativeLocalDocumentIdentity.canonicalPath(fileURL: fileURL))
  }
}

public final class FileNativeSharedDocumentBindingStore: NativeSharedDocumentBindingStore {
  private struct StoreFile: Codable {
    var schemaVersion: Int
    var bindings: [String: NativeSharedDocumentBinding]
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
  ) -> FileNativeSharedDocumentBindingStore {
    let appSupport = appSupportDirectory ?? NativeAppSupportDirectory.url(fileManager: fileManager)
    return FileNativeSharedDocumentBindingStore(fileURL: appSupport.appending(path: "shared-document-bindings.json"), fileManager: fileManager)
  }

  public func loadBinding(fileURL documentURL: URL) throws -> NativeSharedDocumentBinding? {
    try loadStore().bindings[NativeLocalDocumentIdentity.canonicalPath(fileURL: documentURL)]
  }

  public func saveBinding(_ binding: NativeSharedDocumentBinding, fileURL documentURL: URL) throws {
    var store = try loadStore()
    store.bindings[NativeLocalDocumentIdentity.canonicalPath(fileURL: documentURL)] = binding
    try saveStore(store)
  }

  public func clearBinding(fileURL documentURL: URL) throws {
    var store = try loadStore()
    store.bindings.removeValue(forKey: NativeLocalDocumentIdentity.canonicalPath(fileURL: documentURL))
    try saveStore(store)
  }

  private func loadStore() throws -> StoreFile {
    guard fileManager.fileExists(atPath: fileURL.path) else {
      return StoreFile(schemaVersion: 1, bindings: [:])
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
