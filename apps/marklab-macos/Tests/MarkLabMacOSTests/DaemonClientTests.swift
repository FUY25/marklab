import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native daemon client")
struct DaemonClientTests {
  @Test("uses local daemon APIs for share and link management without provider mutation")
  func usesLocalDaemonShareActions() async throws {
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"localDocId":"doc_local","displayName":"note.md","absolutePath":"/tmp/note.md","roomName":"local:doc","hash":"sha256:one","conflict":null,"historyLoadError":null}"#)
    transport.enqueue(json: #"{"relayRoomId":"room_1","hostOnline":true,"links":[],"sessions":[]}"#)
    transport.enqueue(json: #"{"versions":[{"versionId":"version_1","versionNumber":1,"operation":"manual-save","hash":"sha256:version","source":"user","message":"Before edit","createdAt":"2026-05-15T12:00:00.000Z"}]}"#)
    transport.enqueue(json: #"{"versionId":"version_1","versionNumber":1,"hash":"sha256:version"}"#)
    transport.enqueue(json: #"{"relayRoomId":"room_1","hostOnline":true,"links":[],"sessions":[]}"#)
    transport.enqueue(json: #"{"role":"edit","grantId":"grant_edit","relayRoomId":"room_1","url":"http://127.0.0.1:5173/collab?mode=edit"}"#, statusCode: 201)
    transport.enqueue(data: Data(), statusCode: 204)
    let client = NativeDaemonClient(
      apiBaseURL: URL(string: "http://127.0.0.1:3011")!,
      bearerToken: "local_daemon_token",
      transport: transport
    )

    _ = try await client.documentSummary()
    _ = try await client.shareState()
    let versions = try await client.listVersions()
    let restored = try await client.restoreVersion(versionId: "version_1")
    _ = try await client.startSharing()
    let link = try await client.createLink(role: .edit)
    try await client.revokeLink(grantId: "grant/edit")

    #expect(link.url.absoluteString == "http://127.0.0.1:5173/collab?mode=edit")
    #expect(versions.map(\.versionId) == ["version_1"])
    #expect(restored.hash == "sha256:version")
    #expect(transport.requests.map(\.percentEncodedPath) == [
      "/api/local/document",
      "/api/local/share-state",
      "/api/local/versions",
      "/api/local/restore",
      "/api/local/sharing",
      "/api/local/access-grants",
      "/api/local/access-grants/grant%2Fedit",
    ])
    #expect(transport.requests.allSatisfy { $0.authorization == "Bearer local_daemon_token" })
    #expect(transport.requests.allSatisfy { !$0.path.contains("/d/") && !$0.path.contains("/ws/") })
  }
}
