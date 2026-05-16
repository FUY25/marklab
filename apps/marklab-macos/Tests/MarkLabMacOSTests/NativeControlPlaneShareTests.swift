import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native hosted control-plane sharing")
struct NativeControlPlaneShareTests {
  @Test("imports the local file into a workspace and creates browser access grants")
  func importsWorkspaceDocumentAndCreatesAccessLinks() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("# Hosted native\r\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_hosted","branchId":"branch_main","versionId":"version_1","hash":"sha256:hosted"}"#, statusCode: 201)
    transport.enqueue(json: #"{"grantId":"grant_edit","branchId":"branch_main","token":"ml_access_edit","role":"edit","expiresAt":null,"createdAt":"2026-05-15T12:00:00.000Z"}"#, statusCode: 201)
    transport.enqueue(json: #"{"grantId":"grant_view","branchId":"branch_main","token":"ml_access_view","role":"view","expiresAt":null,"createdAt":"2026-05-15T12:01:00.000Z"}"#, statusCode: 201)
    transport.enqueue(data: Data(), statusCode: 204)
    let client = NativeControlPlaneShareClient(
      apiBaseURL: URL(string: "https://api.example.test")!,
      webBaseURL: URL(string: "https://app.example.test")!,
      bearerToken: "ml_user_session",
      workspaceId: "workspace_1",
      transport: transport
    )
    let controller = NativeHostedShareController(client: client)

    let document = try await controller.startSharing(fileURL: fileURL)
    let appEditorURL = try controller.appEditorURL()
    let localDocId = NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)
    let editLink = try await controller.createLink(role: .edit)
    let viewLink = try await controller.createLink(role: .view)
    try await controller.revokeLink(grantId: editLink.grantId)

    #expect(document.docId == "doc_hosted")
    #expect(appEditorURL.absoluteString == "https://app.example.test/collab?docId=doc_hosted&branchId=branch_main&mode=edit&clientKind=app&localDocId=\(localDocId)")
    #expect(!appEditorURL.absoluteString.contains("token="))
    #expect(appEditorURL.fragment == nil)
    #expect(editLink.url.absoluteString == "https://app.example.test/collab?docId=doc_hosted&branchId=branch_main&token=ml_access_edit&mode=edit")
    #expect(viewLink.url.absoluteString == "https://app.example.test/collab?docId=doc_hosted&branchId=branch_main&token=ml_access_view&mode=view")
    #expect(transport.requests.map(\.percentEncodedPath) == [
      "/api/docs/import",
      "/api/docs/doc_hosted/branches/branch_main/access-grants",
      "/api/docs/doc_hosted/branches/branch_main/access-grants",
      "/api/access-grants/grant_edit",
    ])
    #expect(transport.requests.allSatisfy { $0.authorization == "Bearer ml_user_session" })
    let importBody = try #require(transport.requests[0].jsonBody)
    #expect(importBody["workspaceId"] as? String == "workspace_1")
    #expect(importBody["title"] as? String == "note.md")
    #expect(importBody["markdown"] as? String == "# Hosted native\n")
    #expect(try #require(transport.requests[1].jsonBody)["role"] as? String == "edit")
    #expect(try #require(transport.requests[2].jsonBody)["role"] as? String == "view")
  }

  @Test("does not create access grants before a workspace import exists")
  func refusesLinkBeforeDocumentImport() async throws {
    let client = NativeControlPlaneShareClient(
      apiBaseURL: URL(string: "https://api.example.test")!,
      webBaseURL: URL(string: "https://app.example.test")!,
      bearerToken: "ml_user_session",
      workspaceId: "workspace_1",
      transport: RecordingHTTPTransport()
    )
    let controller = NativeHostedShareController(client: client)

    await #expect(throws: NativeHostedShareError.documentNotShared) {
      _ = try await controller.createLink(role: .edit)
    }
  }
}
