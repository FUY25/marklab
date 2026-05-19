import Foundation

public struct MarkLabConflict: Equatable, Codable, Sendable {
  public let conflictId: String
  public let localMarkdown: String
  public let sharedMarkdown: String
  public let baselineMarkdown: String
  public let localHash: String
  public let sharedHash: String
  public let baselineHash: String
  public let sharedStateFingerprint: String
  public let sharedRevision: Int?
  public let sharedEditorURL: URL?
  public let status: String
  public let createdAt: String
  public let updatedAt: String

  public init(
    conflictId: String = "native_conflict_\(UUID().uuidString)",
    localMarkdown: String,
    sharedMarkdown: String,
    baselineMarkdown: String,
    sharedRevision: Int? = nil,
    sharedEditorURL: URL? = nil,
    status: String = "open",
    createdAt: String = ISO8601DateFormatter().string(from: Date()),
    updatedAt: String? = nil
  ) {
    self.conflictId = conflictId
    self.localMarkdown = localMarkdown
    self.sharedMarkdown = sharedMarkdown
    self.baselineMarkdown = baselineMarkdown
    self.localHash = NativeProjectionBaselineRecord.markdownHash(localMarkdown)
    self.sharedHash = NativeProjectionBaselineRecord.markdownHash(sharedMarkdown)
    self.baselineHash = NativeProjectionBaselineRecord.markdownHash(baselineMarkdown)
    self.sharedStateFingerprint = NativeProjectionBaselineRecord.providerYTextFingerprint(sharedMarkdown)
    self.sharedRevision = sharedRevision
    self.sharedEditorURL = sharedEditorURL
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt ?? createdAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let localMarkdown = try container.decode(String.self, forKey: .localMarkdown)
    let sharedMarkdown = try container.decode(String.self, forKey: .sharedMarkdown)
    let baselineMarkdown = try container.decode(String.self, forKey: .baselineMarkdown)
    let createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
      ?? ISO8601DateFormatter().string(from: Date())
    self.conflictId = try container.decodeIfPresent(String.self, forKey: .conflictId)
      ?? "native_conflict_\(UUID().uuidString)"
    self.localMarkdown = localMarkdown
    self.sharedMarkdown = sharedMarkdown
    self.baselineMarkdown = baselineMarkdown
    self.localHash = try container.decodeIfPresent(String.self, forKey: .localHash)
      ?? NativeProjectionBaselineRecord.markdownHash(localMarkdown)
    self.sharedHash = try container.decodeIfPresent(String.self, forKey: .sharedHash)
      ?? NativeProjectionBaselineRecord.markdownHash(sharedMarkdown)
    self.baselineHash = try container.decodeIfPresent(String.self, forKey: .baselineHash)
      ?? NativeProjectionBaselineRecord.markdownHash(baselineMarkdown)
    self.sharedStateFingerprint = try container.decodeIfPresent(String.self, forKey: .sharedStateFingerprint)
      ?? NativeProjectionBaselineRecord.providerYTextFingerprint(sharedMarkdown)
    self.sharedRevision = try container.decodeIfPresent(Int.self, forKey: .sharedRevision)
    self.sharedEditorURL = try container.decodeIfPresent(URL.self, forKey: .sharedEditorURL)
    self.status = try container.decodeIfPresent(String.self, forKey: .status) ?? "open"
    self.createdAt = createdAt
    self.updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt) ?? createdAt
  }

  public func withSharedEditorURL(_ url: URL?) -> MarkLabConflict {
    MarkLabConflict(
      conflictId: conflictId,
      localMarkdown: localMarkdown,
      sharedMarkdown: sharedMarkdown,
      baselineMarkdown: baselineMarkdown,
      sharedRevision: sharedRevision,
      sharedEditorURL: url ?? sharedEditorURL,
      status: status,
      createdAt: createdAt,
      updatedAt: updatedAt
    )
  }

  public var diffPreview: String {
    let localLines = splitConflictLines(localMarkdown)
    let sharedLines = splitConflictLines(sharedMarkdown)
    let lineCount = max(localLines.count, sharedLines.count)
    var preview: [String] = []
    for index in 0..<lineCount {
      let localLine = index < localLines.count ? localLines[index] : nil
      let sharedLine = index < sharedLines.count ? sharedLines[index] : nil
      if localLine == sharedLine {
        if let localLine {
          preview.append("  \(localLine)")
        }
        continue
      }
      if let localLine {
        preview.append("- \(localLine)")
      }
      if let sharedLine {
        preview.append("+ \(sharedLine)")
      }
    }
    return preview.joined(separator: "\n")
  }
}

private func splitConflictLines(_ markdown: String) -> [String] {
  let trimmed = markdown.hasSuffix("\n") ? String(markdown.dropLast()) : markdown
  return trimmed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
}

public final class NativeConflictStore {
  private let directoryURL: URL
  private let fileManager: FileManager

  public init(directoryURL: URL, fileManager: FileManager = .default) {
    self.directoryURL = directoryURL
    self.fileManager = fileManager
  }

  public static func defaultStore(
    appSupportDirectory: URL? = nil,
    fileManager: FileManager = .default
  ) -> NativeConflictStore {
    let appSupport = appSupportDirectory ?? NativeAppSupportDirectory.url(fileManager: fileManager)
    return NativeConflictStore(
      directoryURL: appSupport.appending(path: "conflicts", directoryHint: .isDirectory),
      fileManager: fileManager
    )
  }

  public func load(fileURL: URL) throws -> MarkLabConflict? {
    let url = conflictURL(fileURL: fileURL)
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(MarkLabConflict.self, from: Data(contentsOf: url))
  }

  public func save(_ conflict: MarkLabConflict, fileURL: URL) throws {
    try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(conflict)
    let url = conflictURL(fileURL: fileURL)
    try data.write(to: url, options: .atomic)
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  public func clear(fileURL: URL) {
    try? fileManager.removeItem(at: conflictURL(fileURL: fileURL))
  }

  private func conflictURL(fileURL: URL) -> URL {
    let key = Data(fileURL.standardizedFileURL.path.utf8)
      .base64EncodedString()
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "=", with: "")
    return directoryURL.appendingPathComponent("\(key).json")
  }
}
