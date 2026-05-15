import Foundation

public struct NativeHostedDocument: Decodable, Equatable {
  public let docId: String
  public let branchId: String
  public let versionId: String
  public let hash: String
}

public struct NativeHostedAccessGrant: Decodable, Equatable {
  public let grantId: String
  public let branchId: String
  public let token: String
  public let role: NativeLinkRole
  public let expiresAt: String?
  public let createdAt: String?
}

public struct NativeHostedShareLink: Equatable {
  public let grantId: String
  public let role: NativeLinkRole
  public let url: URL
  public let expiresAt: String?
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

  public func createAccessGrant(document: NativeHostedDocument, role: NativeLinkRole) async throws -> NativeHostedShareLink {
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
      url: browserURL(document: document, grant: grant),
      expiresAt: grant.expiresAt,
      createdAt: grant.createdAt
    )
  }

  public func appEditorURL(document: NativeHostedDocument) -> URL {
    var components = URLComponents(url: appendPath("/collab", to: webBaseURL), resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "docId", value: document.docId),
      URLQueryItem(name: "branchId", value: document.branchId),
      URLQueryItem(name: "mode", value: "edit"),
      URLQueryItem(name: "clientKind", value: "app"),
    ]
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

  private func browserURL(document: NativeHostedDocument, grant: NativeHostedAccessGrant) -> URL {
    var components = URLComponents(url: appendPath("/collab", to: webBaseURL), resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "docId", value: document.docId),
      URLQueryItem(name: "branchId", value: document.branchId),
      URLQueryItem(name: "token", value: grant.token),
      URLQueryItem(name: "mode", value: grant.role.rawValue),
    ]
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
