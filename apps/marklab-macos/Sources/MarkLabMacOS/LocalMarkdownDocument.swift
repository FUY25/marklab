import Foundation
import Darwin

public enum LocalMarkdownDocumentError: Error, Equatable {
  case unreadableUTF8
}

public struct LocalMarkdownDocument: Equatable {
  public let fileURL: URL
  public let shared: Bool
  public private(set) var text: String

  private init(fileURL: URL, shared: Bool, text: String) {
    self.fileURL = fileURL
    self.shared = shared
    self.text = text
  }

  public static func open(fileURL: URL, shared: Bool) throws -> LocalMarkdownDocument {
    let data = try Data(contentsOf: fileURL)
    guard let text = String(data: data, encoding: .utf8) else {
      throw LocalMarkdownDocumentError.unreadableUTF8
    }
    return LocalMarkdownDocument(fileURL: fileURL, shared: shared, text: text)
  }

  public mutating func replaceText(_ nextText: String) {
    text = nextText
  }

  public func markdownForSave() -> String {
    guard shared else { return text }
    return Self.normalizeForSharedSave(text)
  }

  public static func normalizeForSharedSave(_ markdown: String) -> String {
    markdown
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
  }

  public func save() throws {
    try Data(markdownForSave().utf8).write(to: fileURL, options: .atomic)
  }

  public func saveIfCurrentMarkdownMatches(
    _ expectedMarkdown: String,
    beforeReplace: (() -> Void)? = nil,
    beforeVerify: (() -> Void)? = nil
  ) throws -> Bool {
    let directoryURL = fileURL.deletingLastPathComponent()
    let temporaryURL = directoryURL.appendingPathComponent(".\(fileURL.lastPathComponent).marklab-\(UUID().uuidString).tmp")
    let backupURL = directoryURL.appendingPathComponent(".\(fileURL.lastPathComponent).marklab-backup-\(UUID().uuidString).bak")
    try Data(markdownForSave().utf8).write(to: temporaryURL)
    var shouldRemoveBackup = false
    defer {
      try? FileManager.default.removeItem(at: temporaryURL)
      if shouldRemoveBackup {
        try? FileManager.default.removeItem(at: backupURL)
      }
    }

    let descriptor = Darwin.open(fileURL.path, O_RDONLY)
    if descriptor < 0 {
      if errno == ENOENT { return false }
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    defer { Darwin.close(descriptor) }

    let openIdentity = try fileIdentity(descriptor: descriptor)
    guard try fileIdentity(path: fileURL.path) == openIdentity else { return false }
    let latestDocument = try LocalMarkdownDocument.open(fileURL: fileURL, shared: shared)
    guard latestDocument.markdownForSave() == expectedMarkdown else { return false }
    guard try fileIdentity(path: fileURL.path) == openIdentity else { return false }

    try FileManager.default.moveItem(at: fileURL, to: backupURL)
    shouldRemoveBackup = true
    guard try fileIdentity(path: backupURL.path) == openIdentity else {
      try restoreMovedAsideFile(from: backupURL, to: fileURL, restoreOverDestination: false)
      shouldRemoveBackup = false
      return false
    }
    let backupDocument = try LocalMarkdownDocument.open(fileURL: backupURL, shared: shared)
    guard backupDocument.markdownForSave() == expectedMarkdown else {
      try restoreMovedAsideFile(from: backupURL, to: fileURL, restoreOverDestination: false)
      shouldRemoveBackup = false
      return false
    }

    beforeReplace?()
    do {
      try FileManager.default.linkItem(at: temporaryURL, to: fileURL)
    } catch {
      try restoreMovedAsideFile(from: backupURL, to: fileURL, restoreOverDestination: false)
      shouldRemoveBackup = false
      return false
    }
    beforeVerify?()
    let committedDocument = try LocalMarkdownDocument.open(fileURL: fileURL, shared: shared)
    if committedDocument.markdownForSave() != markdownForSave() {
      try restoreMovedAsideFile(from: backupURL, to: fileURL, restoreOverDestination: true)
      shouldRemoveBackup = false
      return false
    }
    try FileManager.default.removeItem(at: backupURL)
    shouldRemoveBackup = false
    return true
  }
}

private func restoreMovedAsideFile(from movedAsideURL: URL, to fileURL: URL, restoreOverDestination: Bool) throws {
  do {
    try FileManager.default.linkItem(at: movedAsideURL, to: fileURL)
    try FileManager.default.removeItem(at: movedAsideURL)
  } catch {
    if FileManager.default.fileExists(atPath: fileURL.path) {
      if restoreOverDestination {
        try? FileManager.default.removeItem(at: fileURL)
        try FileManager.default.linkItem(at: movedAsideURL, to: fileURL)
      }
      try? FileManager.default.removeItem(at: movedAsideURL)
      return
    }
    throw error
  }
}

private struct FileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
}

private func fileIdentity(descriptor: Int32) throws -> FileIdentity {
  var info = stat()
  guard Darwin.fstat(descriptor, &info) == 0 else {
    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }
  return FileIdentity(device: UInt64(info.st_dev), inode: UInt64(info.st_ino))
}

private func fileIdentity(path: String) throws -> FileIdentity {
  let attributes = try FileManager.default.attributesOfItem(atPath: path)
  guard
    let device = attributes[.systemNumber] as? NSNumber,
    let inode = attributes[.systemFileNumber] as? NSNumber
  else {
    throw POSIXError(.EIO)
  }
  return FileIdentity(device: device.uint64Value, inode: inode.uint64Value)
}
