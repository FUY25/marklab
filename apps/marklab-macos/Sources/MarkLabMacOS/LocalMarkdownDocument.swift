import Foundation

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
    return text
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
  }

  public func save() throws {
    try Data(markdownForSave().utf8).write(to: fileURL, options: .atomic)
  }
}
