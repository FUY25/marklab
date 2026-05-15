import Darwin
import Foundation

public enum NativeDaemonOwnerKind: String, Codable, Equatable {
  case cli
  case app
}

public struct NativeDaemonRegistryEntry: Codable, Equatable {
  public let schemaVersion: Int
  public let id: String
  public let realpath: String
  public let displayName: String
  public let pid: Int32
  public let apiPort: Int
  public let webPort: Int
  public let apiUrl: URL
  public let webUrl: URL
  public let localUrl: URL
  public let token: String
  public let ownerKind: NativeDaemonOwnerKind
  public let startedAt: String
  public let updatedAt: String

  public init(
    id: String = UUID().uuidString,
    realpath: String,
    pid: Int32,
    apiPort: Int,
    webPort: Int,
    apiUrl: URL,
    webUrl: URL,
    localUrl: URL,
    token: String,
    ownerKind: NativeDaemonOwnerKind = .app,
    startedAt: String = NativeDaemonRegistryEntry.nowISO8601(),
    updatedAt: String = NativeDaemonRegistryEntry.nowISO8601()
  ) {
    self.schemaVersion = 1
    self.id = id
    self.realpath = realpath
    self.displayName = URL(fileURLWithPath: realpath).lastPathComponent
    self.pid = pid
    self.apiPort = apiPort
    self.webPort = webPort
    self.apiUrl = apiUrl
    self.webUrl = webUrl
    self.localUrl = localUrl
    self.token = token
    self.ownerKind = ownerKind
    self.startedAt = startedAt
    self.updatedAt = updatedAt
  }

  public static func nowISO8601() -> String {
    ISO8601DateFormatter().string(from: Date())
  }
}

public struct NativeDaemonRegistryDocument: Codable, Equatable {
  public let schemaVersion: Int
  public let daemons: [NativeDaemonRegistryEntry]

  public init(schemaVersion: Int = 1, daemons: [NativeDaemonRegistryEntry]) {
    self.schemaVersion = schemaVersion
    self.daemons = daemons
  }
}

public enum NativeDaemonRegistryError: Error, Equatable {
  case lockUnavailable
}

public struct NativeDaemonRegistry {
  public let fileURL: URL

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  public func read() throws -> NativeDaemonRegistryDocument {
    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      return NativeDaemonRegistryDocument(daemons: [])
    }
    let data = try Data(contentsOf: fileURL)
    let document = try JSONDecoder().decode(NativeDaemonRegistryDocument.self, from: data)
    guard document.schemaVersion == 1 else {
      return NativeDaemonRegistryDocument(daemons: [])
    }
    return document
  }

  public func write(entries: [NativeDaemonRegistryEntry]) throws {
    try withLock {
      let document = NativeDaemonRegistryDocument(daemons: entries)
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let data = try encoder.encode(document)
      let directoryURL = fileURL.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
      let temporaryURL = directoryURL.appending(path: ".\(fileURL.lastPathComponent).\(UUID().uuidString).tmp")
      FileManager.default.createFile(
        atPath: temporaryURL.path,
        contents: data,
        attributes: [.posixPermissions: 0o600]
      )
      do {
        if FileManager.default.fileExists(atPath: fileURL.path) {
          _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: temporaryURL)
        } else {
          try FileManager.default.moveItem(at: temporaryURL, to: fileURL)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
      } catch {
        try? FileManager.default.removeItem(at: temporaryURL)
        throw error
      }
    }
  }

  private func withLock<T>(_ callback: () throws -> T) throws -> T {
    let directoryURL = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    let lockPath = "\(fileURL.path).lock"
    let descriptor = open(lockPath, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else {
      if errno == EEXIST { throw NativeDaemonRegistryError.lockUnavailable }
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    close(descriptor)
    defer {
      unlink(lockPath)
    }
    return try callback()
  }
}
