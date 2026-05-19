import Foundation

public struct NativeHostedDocument: Decodable, Equatable, Sendable {
  public let docId: String
  public let branchId: String
  public let versionId: String
  public let hash: String
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
}
