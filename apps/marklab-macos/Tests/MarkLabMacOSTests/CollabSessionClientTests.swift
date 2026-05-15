import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native control-plane session client")
struct CollabSessionClientTests {
  @Test("requests app edit sessions and refreshes with the session refresh token only")
  func appEditSessionRefreshUsesSessionTokenOnly() async throws {
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: """
      {
        "mode": "edit",
        "session": {
          "sessionId": "session_app",
          "clientKind": "app",
          "displayName": "MarkLab.app",
          "refreshToken": "refresh_session_secret"
        },
        "providerToken": {
          "providerDocId": "ml_doc_1",
          "sessionId": "session_app",
          "authorization": "full",
          "validForSeconds": 600,
          "issuedAt": "2026-05-15T12:00:00.000Z",
          "expiresAt": "2026-05-15T12:10:00.000Z",
          "clientToken": {
            "docId": "ml_doc_1",
            "url": "ws://api.example.test/d/ml_doc_1/ws/ml_doc_1",
            "baseUrl": "https://api.example.test/d/ml_doc_1",
            "token": "ysweet_initial",
            "authorization": "full"
          }
        }
      }
      """)
    transport.enqueue(json: """
      {
        "providerToken": {
          "providerDocId": "ml_doc_1",
          "sessionId": "session_app",
          "authorization": "full",
          "validForSeconds": 600,
          "issuedAt": "2026-05-15T12:05:00.000Z",
          "expiresAt": "2026-05-15T12:15:00.000Z",
          "clientToken": {
            "docId": "ml_doc_1",
            "url": "ws://api.example.test/d/ml_doc_1/ws/ml_doc_1",
            "baseUrl": "https://api.example.test/d/ml_doc_1",
            "token": "ysweet_refreshed",
            "authorization": "full"
          }
        }
      }
      """)
    let client = NativeCollabSessionClient(
      apiBaseURL: URL(string: "https://api.example.test")!,
      bearerToken: "user_session_token",
      transport: transport
    )

    let session = try await client.createEditSession(
      docId: "doc/1",
      branchId: "branch #1",
      displayName: "MarkLab.app",
      shareToken: "ml_access_edit"
    )
    let refreshed = try await client.refreshProviderToken(session)

    #expect(refreshed.clientToken.token == "ysweet_refreshed")
    let createBody = try #require(transport.requests[0].jsonBody)
    #expect(createBody["mode"] as? String == "edit")
    #expect(createBody["clientKind"] as? String == "app")
    #expect(createBody["displayName"] as? String == "MarkLab.app")
    #expect(transport.requests.map(\.percentEncodedPath) == [
      "/api/docs/doc%2F1/branches/branch%20%231/collab/session",
      "/api/docs/doc%2F1/branches/branch%20%231/collab/session/session_app/provider-token/refresh",
    ])
    #expect(transport.requests[0].authorization == "Bearer user_session_token")
    #expect(transport.requests[1].authorization == "Bearer user_session_token")
    #expect(transport.requests[0].nativeAppProof == "1")
    #expect(transport.requests[1].nativeAppProof == "1")
    #expect(transport.requests[1].bodyString == #"{"refreshToken":"refresh_session_secret"}"#)
    #expect(!transport.requests[1].bodyString.contains("ysweet_initial"))
    #expect(!transport.requests[1].bodyString.contains("ml_access_edit"))
  }

  @Test("rejects refreshed provider tokens for the wrong provider document")
  func rejectsMismatchedRefreshToken() async throws {
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: """
      {
        "providerToken": {
          "providerDocId": "ml_doc_other",
          "sessionId": "session_app",
          "authorization": "full",
          "validForSeconds": 600,
          "issuedAt": "2026-05-15T12:05:00.000Z",
          "expiresAt": "2026-05-15T12:15:00.000Z",
          "clientToken": {
            "docId": "ml_doc_other",
            "url": "ws://api.example.test/d/ml_doc_other/ws/ml_doc_other",
            "baseUrl": "https://api.example.test/d/ml_doc_other",
            "token": "ysweet_wrong",
            "authorization": "full"
          }
        }
      }
      """)
    let client = NativeCollabSessionClient(apiBaseURL: URL(string: "https://api.example.test")!, transport: transport)
    let session = ActiveNativeEditSession(
      docId: "doc_1",
      branchId: "branch_1",
      sessionId: "session_app",
      refreshToken: "refresh_session_secret",
      providerDocId: "ml_doc_1",
      providerToken: nil
    )

    await #expect(throws: NativeCollabSessionError.invalidProviderTokenRefresh) {
      _ = try await client.refreshProviderToken(session)
    }
  }
}
