import Foundation

public enum NativeLinkRole: String, Codable, Equatable, Sendable {
  case view
  case edit
}

public struct NativeLocalDocumentSummary: Decodable, Equatable {
  public let localDocId: String
  public let displayName: String
  public let absolutePath: String
  public let roomName: String
  public let hash: String
  public let conflict: String?
  public let historyLoadError: String?
}

public struct NativeShareState: Decodable, Equatable {
  public let relayRoomId: String?
  public let hostOnline: Bool
}

public struct NativeLocalVersionSummary: Decodable, Equatable {
  public let versionId: String
  public let versionNumber: Int
  public let operation: String
  public let hash: String
  public let source: String?
  public let message: String?
  public let createdAt: String
}

public struct NativeAppContext: Decodable, Equatable {
  public let document: NativeLocalDocumentSummary
  public let versions: [NativeLocalVersionSummary]
  public let conflict: String?
  public let shareState: NativeShareState
}

public struct NativeShareLink: Decodable, Equatable {
  public let role: NativeLinkRole
  public let grantId: String
  public let relayRoomId: String?
  public let url: URL
  public let expiresAt: String?
  public let createdAt: String?
}

public struct NativeRestoreVersionResult: Decodable, Equatable {
  public let versionId: String
  public let versionNumber: Int
  public let hash: String
}

public final class NativeDaemonClient: @unchecked Sendable {
  private let apiBaseURL: URL
  private let bearerToken: String
  private let transport: NativeHTTPTransport

  public init(apiBaseURL: URL, bearerToken: String, transport: NativeHTTPTransport = URLSessionNativeHTTPTransport()) {
    self.apiBaseURL = apiBaseURL
    self.bearerToken = bearerToken
    self.transport = transport
  }

  public func documentSummary() async throws -> NativeLocalDocumentSummary {
    try await sendJSON("GET", "/api/local/document", response: NativeLocalDocumentSummary.self)
  }

  public func appContext() async throws -> NativeAppContext {
    try await sendJSON("GET", "/api/local/app-context", response: NativeAppContext.self)
  }

  public func shareState() async throws -> NativeShareState {
    try await sendJSON("GET", "/api/local/share-state", response: NativeShareState.self)
  }

  public func listVersions() async throws -> [NativeLocalVersionSummary] {
    struct Response: Decodable {
      let versions: [NativeLocalVersionSummary]
    }
    return try await sendJSON("GET", "/api/local/versions", response: Response.self).versions
  }

  public func restoreVersion(versionId: String) async throws -> NativeRestoreVersionResult {
    struct RestoreBody: Encodable {
      let versionId: String
    }
    return try await sendJSON(
      "POST",
      "/api/local/restore",
      body: RestoreBody(versionId: versionId),
      response: NativeRestoreVersionResult.self
    )
  }

  public func startSharing() async throws -> NativeShareState {
    try await sendJSON("POST", "/api/local/sharing", response: NativeShareState.self)
  }

  public func createLink(role: NativeLinkRole) async throws -> NativeShareLink {
    struct CreateLinkBody: Encodable {
      let role: NativeLinkRole
    }
    return try await sendJSON(
      "POST",
      "/api/local/access-grants",
      body: CreateLinkBody(role: role),
      response: NativeShareLink.self
    )
  }

  public func revokeLink(grantId: String) async throws {
    let encodedGrantId = encodeNativePathSegment(grantId)
    _ = try await sendJSON(
      "DELETE",
      "/api/local/access-grants/\(encodedGrantId)",
      response: EmptyNativeResponse.self
    )
  }

  private func sendJSON<Response: Decodable>(
    _ method: String,
    _ path: String,
    response responseType: Response.Type
  ) async throws -> Response {
    try await sendJSON(method, path, bodyData: nil, response: responseType)
  }

  private func sendJSON<Body: Encodable, Response: Decodable>(
    _ method: String,
    _ path: String,
    body: Body,
    response responseType: Response.Type
  ) async throws -> Response {
    try await sendJSON(method, path, bodyData: nativeJSONData(body), response: responseType)
  }

  private func sendJSON<Response: Decodable>(
    _ method: String,
    _ path: String,
    bodyData: Data?,
    response responseType: Response.Type
  ) async throws -> Response {
    var headers = [
      "Authorization": "Bearer \(bearerToken)",
    ]
    if bodyData != nil {
      headers["Content-Type"] = "application/json"
    }
    let request = NativeHTTPRequest(method: method, url: appendPath(path, to: apiBaseURL), headers: headers, body: bodyData)
    return try decodeNativeJSON(responseType, from: try await transport.send(request))
  }
}
