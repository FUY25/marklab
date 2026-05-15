import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native share controller")
struct NativeShareControllerTests {
  @Test("loads native app context and runs share actions through the local daemon")
  func loadsContextAndRunsShareActions() async throws {
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: """
      {
        "document": {
          "localDocId": "doc_local",
          "displayName": "note.md",
          "absolutePath": "/tmp/note.md",
          "roomName": "local:doc",
          "hash": "sha256:one",
          "conflict": null,
          "historyLoadError": null
        },
        "versions": [],
        "conflict": null,
        "shareState": {
          "relayRoomId": "room_1",
          "hostOnline": true,
          "links": [],
          "sessions": []
        }
      }
      """)
    transport.enqueue(json: #"{"relayRoomId":"room_1","hostOnline":true,"links":[],"sessions":[]}"#)
    transport.enqueue(json: #"{"role":"edit","grantId":"grant_edit","relayRoomId":"room_1","url":"https://marklab.example/collab?mode=edit"}"#, statusCode: 201)
    transport.enqueue(json: #"{"role":"view","grantId":"grant_view","relayRoomId":"room_1","url":"https://marklab.example/collab?mode=view"}"#, statusCode: 201)
    transport.enqueue(data: Data(), statusCode: 204)

    let client = NativeDaemonClient(
      apiBaseURL: URL(string: "http://127.0.0.1:3011")!,
      bearerToken: "local_daemon_token",
      transport: transport
    )
    let controller = NativeShareController(daemonClient: client)

    let context = try await controller.loadContext()
    _ = try await controller.startSharing()
    let editLink = try await controller.createEditLink()
    let viewLink = try await controller.createViewLink()
    try await controller.revokeLink(grantId: "grant_edit")

    #expect(context.document.absolutePath == "/tmp/note.md")
    #expect(editLink.role == .edit)
    #expect(viewLink.role == .view)
    #expect(controller.browserLinkString(for: editLink) == "https://marklab.example/collab?mode=edit")
    #expect(transport.requests.map(\.path) == [
      "/api/local/app-context",
      "/api/local/sharing",
      "/api/local/access-grants",
      "/api/local/access-grants",
      "/api/local/access-grants/grant_edit",
    ])
  }
}
