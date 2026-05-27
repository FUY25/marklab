import Foundation

public enum NativeLinkRole: String, Codable, Equatable, Sendable {
  case edit
  case view
}

public struct NativeHostedDocument: Decodable, Equatable, Sendable {
  public let docId: String
  public let branchId: String
  public let versionId: String
  public let hash: String

  public init(docId: String, branchId: String, versionId: String, hash: String) {
    self.docId = docId
    self.branchId = branchId
    self.versionId = versionId
    self.hash = hash
  }
}

public struct NativeHostedAccessGrant: Decodable, Equatable, Sendable {
  public let grantId: String
  public let branchId: String
  public let token: String
  public let role: NativeLinkRole
  public let expiresAt: String?
  public let createdAt: String?
}

public struct NativeHostedShareLink: Equatable, Sendable {
  public let grantId: String
  public let role: NativeLinkRole
  public let url: URL
  public let expiresAt: String?
  public let createdAt: String?
}

public struct NativeHostedAccessGrantSummary: Decodable, Equatable, Sendable {
  public let grantId: String
  public let role: NativeLinkRole
  public let branchId: String
  public let expiresAt: String?
  public let revokedAt: String?
  public let createdAt: String?
}

public enum NativeVersionActorType: String, Decodable, Equatable, Sendable {
  case agent
  case user
  case system
}

public enum NativeVersionOperation: String, Decodable, Equatable, Sendable {
  case create
  case `import`
  case autosave
  case manualSave = "manual_save"
  case write
  case edit
  case rollback
  case branch
}

public struct NativeDocumentVersionSummary: Decodable, Equatable, Sendable, Identifiable {
  public var id: String { versionId }

  public let versionId: String
  public let parentVersionId: String?
  public let versionNumber: Int
  public let hash: String
  public let actorType: NativeVersionActorType
  public let actorId: String?
  public let operation: NativeVersionOperation
  public let createdAt: String
}

public struct NativeDocumentVersionSnapshot: Decodable, Equatable, Sendable {
  public let versionId: String
  public let branchId: String
  public let parentVersionId: String?
  public let versionNumber: Int
  public let markdown: String
  public let hash: String
  public let actorType: NativeVersionActorType
  public let actorId: String?
  public let operation: NativeVersionOperation
  public let createdAt: String
}

public struct NativeVersionSaveResult: Decodable, Equatable, Sendable {
  public let created: Bool
  public let versionId: String
  public let versionNumber: Int
  public let hash: String
}

public struct NativeVersionRestoreResult: Decodable, Equatable, Sendable {
  public let versionId: String
  public let versionNumber: Int
  public let hash: String
}

public struct NativeDeleteCloudCopyResult: Decodable, Equatable, Sendable {
  public let deleted: Bool
  public let docId: String
  public let branchIds: [String]
  public let providerDocIds: [String]
  public let localFilePreserved: Bool
}

public enum NativeVersionHistoryError: Error, Equatable {
  case forbidden
  case unavailable
  case restoreFailed
  case staleOrMissingVersion
}

public final class NativeControlPlaneShareClient: @unchecked Sendable {
  private let apiBaseURL: URL
  private let webBaseURL: URL
  private let bearerToken: String
  private let workspaceId: String
  private let transport: NativeHTTPTransport

  public init(
    apiBaseURL: URL,
    webBaseURL: URL,
    bearerToken: String,
    workspaceId: String,
    transport: NativeHTTPTransport = URLSessionNativeHTTPTransport()
  ) {
    self.apiBaseURL = apiBaseURL
    self.webBaseURL = webBaseURL
    self.bearerToken = bearerToken
    self.workspaceId = workspaceId
    self.transport = transport
  }

  public func importMarkdown(fileURL: URL, markdown: String) async throws -> NativeHostedDocument {
    struct Body: Encodable {
      let title: String
      let markdown: String
      let workspaceId: String
    }
    return try await sendJSON(
      "POST",
      "/api/docs/import",
      body: Body(title: fileURL.lastPathComponent, markdown: markdown, workspaceId: workspaceId),
      response: NativeHostedDocument.self
    )
  }

  public func createAccessGrant(
    document: NativeHostedDocument,
    role: NativeLinkRole,
    suggestedFilename: String? = nil
  ) async throws -> NativeHostedShareLink {
    struct Body: Encodable {
      let role: NativeLinkRole
    }
    let grant = try await sendJSON(
      "POST",
      "/api/docs/\(encodeNativePathSegment(document.docId))/branches/\(encodeNativePathSegment(document.branchId))/access-grants",
      body: Body(role: role),
      response: NativeHostedAccessGrant.self
    )
    return NativeHostedShareLink(
      grantId: grant.grantId,
      role: grant.role,
      url: browserURL(document: document, grant: grant, suggestedFilename: suggestedFilename),
      expiresAt: grant.expiresAt,
      createdAt: grant.createdAt
    )
  }

  public func appEditorURL(document: NativeHostedDocument, localDocId: String? = nil) -> URL {
    var components = URLComponents(url: appendPath("/collab", to: webBaseURL), resolvingAgainstBaseURL: false)!
    var queryItems = [
      URLQueryItem(name: "docId", value: document.docId),
      URLQueryItem(name: "branchId", value: document.branchId),
      URLQueryItem(name: "mode", value: "edit"),
      URLQueryItem(name: "clientKind", value: "app"),
      URLQueryItem(name: "nativeShell", value: "markedit"),
    ]
    if let localDocId, !localDocId.isEmpty {
      queryItems.append(URLQueryItem(name: "localDocId", value: localDocId))
    }
    components.queryItems = queryItems
    return components.url!
  }

  public func revokeAccessGrant(grantId: String) async throws {
    let request = NativeHTTPRequest(
      method: "DELETE",
      url: appendPath("/api/access-grants/\(encodeNativePathSegment(grantId))", to: apiBaseURL),
      headers: ["Authorization": "Bearer \(bearerToken)"]
    )
    _ = try decodeNativeJSON(EmptyNativeResponse.self, from: try await transport.send(request))
  }

  public func listAccessGrants(document: NativeHostedDocument) async throws -> [NativeHostedAccessGrantSummary] {
    struct Response: Decodable {
      let grants: [NativeHostedAccessGrantSummary]
    }
    let request = NativeHTTPRequest(
      method: "GET",
      url: appendPath(
        "/api/docs/\(encodeNativePathSegment(document.docId))/branches/\(encodeNativePathSegment(document.branchId))/access-grants",
        to: apiBaseURL
      ),
      headers: ["Authorization": "Bearer \(bearerToken)"]
    )
    return try decodeNativeJSON(Response.self, from: try await transport.send(request)).grants
  }

  public func listVersions(document: NativeHostedDocument) async throws -> [NativeDocumentVersionSummary] {
    struct Response: Decodable {
      let versions: [NativeDocumentVersionSummary]
    }
    return try await sendVersionJSON(
      "GET",
      "/api/docs/\(encodeNativePathSegment(document.docId))/branches/\(encodeNativePathSegment(document.branchId))/versions",
      response: Response.self
    ).versions
  }

  public func showVersion(
    document: NativeHostedDocument,
    versionId: String
  ) async throws -> NativeDocumentVersionSnapshot {
    try await sendVersionJSON(
      "GET",
      "/api/docs/\(encodeNativePathSegment(document.docId))/versions/\(encodeNativePathSegment(versionId))",
      response: NativeDocumentVersionSnapshot.self
    )
  }

  public func saveVersion(document: NativeHostedDocument) async throws -> NativeVersionSaveResult {
    try await sendVersionJSON(
      "POST",
      "/api/docs/\(encodeNativePathSegment(document.docId))/branches/\(encodeNativePathSegment(document.branchId))/versions/manual-save",
      response: NativeVersionSaveResult.self
    )
  }

  public func autosaveVersion(document: NativeHostedDocument) async throws -> NativeVersionSaveResult {
    try await sendVersionJSON(
      "POST",
      "/api/docs/\(encodeNativePathSegment(document.docId))/branches/\(encodeNativePathSegment(document.branchId))/versions/autosave",
      response: NativeVersionSaveResult.self
    )
  }

  public func restoreVersion(
    document: NativeHostedDocument,
    versionId: String
  ) async throws -> NativeVersionRestoreResult {
    struct Body: Encodable {
      let versionId: String
    }
    return try await sendVersionJSON(
      "POST",
      "/api/docs/\(encodeNativePathSegment(document.docId))/branches/\(encodeNativePathSegment(document.branchId))/restore",
      body: try nativeJSONData(Body(versionId: versionId)),
      response: NativeVersionRestoreResult.self
    )
  }

  public func deleteCloudCopy(document: NativeHostedDocument) async throws -> NativeDeleteCloudCopyResult {
    try await sendVersionJSON(
      "DELETE",
      "/api/docs/\(encodeNativePathSegment(document.docId))/branches/\(encodeNativePathSegment(document.branchId))/cloud-copy",
      response: NativeDeleteCloudCopyResult.self
    )
  }

  private func browserURL(
    document: NativeHostedDocument,
    grant: NativeHostedAccessGrant,
    suggestedFilename: String?
  ) -> URL {
    var components = URLComponents(url: appendPath("/collab", to: webBaseURL), resolvingAgainstBaseURL: false)!
    var queryItems = [
      URLQueryItem(name: "docId", value: document.docId),
      URLQueryItem(name: "branchId", value: document.branchId),
      URLQueryItem(name: "token", value: grant.token),
      URLQueryItem(name: "mode", value: grant.role.rawValue),
    ]
    if let filename = NativeSharedDocumentLink.safeMarkdownFilename(suggestedFilename, fallback: nil) {
      queryItems.append(URLQueryItem(name: "filename", value: filename))
    }
    components.queryItems = queryItems
    return components.url!
  }

  private func sendJSON<Body: Encodable, Response: Decodable>(
    _ method: String,
    _ path: String,
    body: Body,
    response responseType: Response.Type
  ) async throws -> Response {
    let request = NativeHTTPRequest(
      method: method,
      url: appendPath(path, to: apiBaseURL),
      headers: [
        "Authorization": "Bearer \(bearerToken)",
        "Content-Type": "application/json",
      ],
      body: try nativeJSONData(body)
    )
    return try decodeNativeJSON(responseType, from: try await transport.send(request))
  }

  private func sendVersionJSON<Response: Decodable>(
    _ method: String,
    _ path: String,
    body: Data? = nil,
    response responseType: Response.Type
  ) async throws -> Response {
    var headers = ["Authorization": "Bearer \(bearerToken)"]
    if body != nil {
      headers["Content-Type"] = "application/json"
    }
    let request = NativeHTTPRequest(
      method: method,
      url: appendPath(path, to: apiBaseURL),
      headers: headers,
      body: body
    )
    let nativeResponse = try await transport.send(request)
    guard (200..<300).contains(nativeResponse.statusCode) else {
      throw versionHistoryError(statusCode: nativeResponse.statusCode)
    }
    return try decodeNativeJSON(responseType, from: nativeResponse)
  }

  private func versionHistoryError(statusCode: Int) -> NativeVersionHistoryError {
    switch statusCode {
    case 401, 403:
      return .forbidden
    case 400, 404, 409, 410:
      return .staleOrMissingVersion
    case 503, 504:
      return .unavailable
    default:
      if statusCode >= 500 {
        return .restoreFailed
      }
      return .unavailable
    }
  }
}
