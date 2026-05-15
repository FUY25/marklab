import Foundation

public enum NativeProviderAuthorization: String, Codable, Equatable {
  case full
  case readOnly = "read-only"
}

public struct NativeProviderClientToken: Codable, Equatable {
  public let docId: String
  public let url: URL
  public let baseUrl: URL
  public let token: String
  public let authorization: NativeProviderAuthorization
}

public struct IssuedNativeProviderToken: Codable, Equatable {
  public let providerDocId: String
  public let sessionId: String
  public let authorization: NativeProviderAuthorization
  public let validForSeconds: Int
  public let issuedAt: String
  public let expiresAt: String
  public let clientToken: NativeProviderClientToken
}

public struct ActiveNativeEditSession: Equatable {
  public let docId: String
  public let branchId: String
  public let sessionId: String
  public let refreshToken: String
  public let providerDocId: String
  public let providerToken: IssuedNativeProviderToken?

  public init(
    docId: String,
    branchId: String,
    sessionId: String,
    refreshToken: String,
    providerDocId: String,
    providerToken: IssuedNativeProviderToken?
  ) {
    self.docId = docId
    self.branchId = branchId
    self.sessionId = sessionId
    self.refreshToken = refreshToken
    self.providerDocId = providerDocId
    self.providerToken = providerToken
  }
}

public enum NativeCollabSessionError: Error, Equatable {
  case invalidEditSessionResponse
  case invalidProviderTokenRefresh
}

public final class NativeCollabSessionClient: @unchecked Sendable {
  private let apiBaseURL: URL
  private let transport: NativeHTTPTransport
  private let bearerToken: String?

  public init(
    apiBaseURL: URL,
    bearerToken: String? = nil,
    transport: NativeHTTPTransport = URLSessionNativeHTTPTransport()
  ) {
    self.apiBaseURL = apiBaseURL
    self.bearerToken = bearerToken
    self.transport = transport
  }

  public func createEditSession(
    docId: String,
    branchId: String,
    displayName: String,
    shareToken: String?
  ) async throws -> ActiveNativeEditSession {
    struct Body: Encodable {
      let mode: String
      let clientKind: String
      let displayName: String
    }
    struct Session: Decodable {
      let sessionId: String
      let clientKind: String
      let displayName: String
      let refreshToken: String
    }
    struct Response: Decodable {
      let mode: String
      let session: Session
      let providerToken: IssuedNativeProviderToken
    }

    var url = collabSessionURL(docId: docId, branchId: branchId)
    if let shareToken {
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
      components.queryItems = [URLQueryItem(name: "token", value: shareToken)]
      url = components.url!
    }
    let request = NativeHTTPRequest(
      method: "POST",
      url: url,
      headers: jsonHeaders(),
      body: try nativeJSONData(Body(mode: "edit", clientKind: "app", displayName: displayName))
    )
    let body = try decodeNativeJSON(Response.self, from: try await transport.send(request))
    guard body.mode == "edit", body.session.clientKind == "app" else {
      throw NativeCollabSessionError.invalidEditSessionResponse
    }
    guard providerTokenMatchesSession(body.providerToken, sessionId: body.session.sessionId, providerDocId: body.providerToken.providerDocId) else {
      throw NativeCollabSessionError.invalidEditSessionResponse
    }
    return ActiveNativeEditSession(
      docId: docId,
      branchId: branchId,
      sessionId: body.session.sessionId,
      refreshToken: body.session.refreshToken,
      providerDocId: body.providerToken.providerDocId,
      providerToken: body.providerToken
    )
  }

  public func refreshProviderToken(_ session: ActiveNativeEditSession) async throws -> IssuedNativeProviderToken {
    struct Body: Encodable {
      let refreshToken: String
    }
    struct Response: Decodable {
      let providerToken: IssuedNativeProviderToken
    }
    let request = NativeHTTPRequest(
      method: "POST",
      url: appendPath(
        "/provider-token/refresh",
        to: collabSessionURL(docId: session.docId, branchId: session.branchId)
          .appending(path: session.sessionId)
      ),
      headers: jsonHeaders(),
      body: try nativeJSONData(Body(refreshToken: session.refreshToken))
    )
    let body = try decodeNativeJSON(Response.self, from: try await transport.send(request))
    guard providerTokenMatchesSession(body.providerToken, sessionId: session.sessionId, providerDocId: session.providerDocId) else {
      throw NativeCollabSessionError.invalidProviderTokenRefresh
    }
    return body.providerToken
  }

  private func collabSessionURL(docId: String, branchId: String) -> URL {
    appendPath(
      "/api/docs/\(encodeNativePathSegment(docId))/branches/\(encodeNativePathSegment(branchId))/collab/session",
      to: apiBaseURL
    )
  }

  private func providerTokenMatchesSession(_ token: IssuedNativeProviderToken, sessionId: String, providerDocId: String) -> Bool {
    token.sessionId == sessionId
      && token.providerDocId == providerDocId
      && token.clientToken.docId == providerDocId
      && token.authorization == .full
      && token.clientToken.authorization == .full
  }

  private func jsonHeaders() -> [String: String] {
    var headers = ["Content-Type": "application/json"]
    if let bearerToken, !bearerToken.isEmpty {
      headers["Authorization"] = "Bearer \(bearerToken)"
      headers["X-MarkLab-Native-App"] = "1"
    }
    return headers
  }
}
