import Foundation

public enum NativeSharedDocumentLinkMode: String, Codable, Equatable, Sendable {
  case edit
  case view
}

public enum NativeSharedDocumentLinkError: Error, Equatable {
  case invalidURL
  case unsupportedURL
  case missingDocId
  case missingBranchId
  case missingAccessToken
  case invalidMode
  case localJoinRequiresEditLink
  case localFileNotEmpty
}

public struct NativeSharedDocumentLink: Equatable, Sendable {
  public let originalURL: URL
  public let docId: String
  public let branchId: String
  public let token: String?
  public let mode: NativeSharedDocumentLinkMode
  public let suggestedFilename: String?

  public init(
    originalURL: URL,
    docId: String,
    branchId: String,
    token: String?,
    mode: NativeSharedDocumentLinkMode,
    suggestedFilename: String? = nil
  ) {
    self.originalURL = originalURL
    self.docId = docId
    self.branchId = branchId
    self.token = token
    self.mode = mode
    self.suggestedFilename = suggestedFilename
  }

  public static func parse(_ value: String) throws -> NativeSharedDocumentLink {
    guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      throw NativeSharedDocumentLinkError.invalidURL
    }
    return try parse(url)
  }

  public static func parse(_ url: URL) throws -> NativeSharedDocumentLink {
    if url.scheme == "marklab", url.host == "join" {
      guard
        let encodedURL = URLComponents(url: url, resolvingAgainstBaseURL: false)?
          .queryItems?
          .first(where: { $0.name == "url" })?
          .value,
        let collabURL = URL(string: encodedURL)
      else {
        throw NativeSharedDocumentLinkError.invalidURL
      }
      return try parse(collabURL)
    }

    guard url.scheme == "http" || url.scheme == "https" else {
      throw NativeSharedDocumentLinkError.unsupportedURL
    }
    guard url.path == "/collab" else {
      throw NativeSharedDocumentLinkError.unsupportedURL
    }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw NativeSharedDocumentLinkError.invalidURL
    }
    let queryItems = components.queryItems ?? []
    func queryValue(_ name: String) -> String? {
      queryItems.first(where: { $0.name == name })?.value
    }
    guard let docId = queryValue("docId"), !docId.isEmpty else {
      throw NativeSharedDocumentLinkError.missingDocId
    }
    guard let branchId = queryValue("branchId"), !branchId.isEmpty else {
      throw NativeSharedDocumentLinkError.missingBranchId
    }
    let rawMode = queryValue("mode") ?? "edit"
    guard let mode = NativeSharedDocumentLinkMode(rawValue: rawMode) else {
      throw NativeSharedDocumentLinkError.invalidMode
    }
    return NativeSharedDocumentLink(
      originalURL: url,
      docId: docId,
      branchId: branchId,
      token: queryValue("token"),
      mode: mode,
      suggestedFilename: safeMarkdownFilename(queryValue("filename") ?? queryValue("name"), fallback: nil)
    )
  }

  public var localFilename: String {
    Self.safeMarkdownFilename(suggestedFilename, fallback: "shared-\(docId).md") ?? "shared-\(docId).md"
  }

  public static func safeMarkdownFilename(_ value: String?, fallback: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty else { return fallback }
    guard
      !trimmed.contains("/"),
      !trimmed.contains("\\"),
      trimmed != ".",
      trimmed != ".."
    else {
      return fallback
    }
    let lowercased = trimmed.lowercased()
    if lowercased.hasSuffix(".md") || lowercased.hasSuffix(".markdown") {
      return trimmed
    }
    return "\(trimmed).md"
  }

  public func appEditorURL(localDocId: String) -> URL {
    var components = URLComponents(url: originalURL, resolvingAgainstBaseURL: false)!
    var queryItems = [
      URLQueryItem(name: "docId", value: docId),
      URLQueryItem(name: "branchId", value: branchId),
    ]
    if let token, !token.isEmpty {
      queryItems.append(URLQueryItem(name: "token", value: token))
    }
    queryItems.append(contentsOf: [
      URLQueryItem(name: "mode", value: mode.rawValue),
      URLQueryItem(name: "clientKind", value: "app"),
      URLQueryItem(name: "nativeShell", value: "markedit"),
      URLQueryItem(name: "localDocId", value: localDocId),
    ])
    if let suggestedFilename {
      queryItems.append(URLQueryItem(name: "filename", value: suggestedFilename))
    }
    components.queryItems = queryItems
    components.percentEncodedFragment = nil
    return components.url!
  }

  public func nativeDeepLinkURL() -> URL {
    var components = URLComponents()
    components.scheme = "marklab"
    components.host = "join"
    components.queryItems = [URLQueryItem(name: "url", value: originalURL.absoluteString)]
    return components.url!
  }
}
