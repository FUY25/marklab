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
    transport.enqueue(json: #"{"grants":[{"grantId":"grant_view","branchId":"branch_main","branchName":"main","role":"view","expiresAt":null,"revokedAt":null,"createdAt":"2026-05-15T12:01:00.000Z","sessions":[]},{"grantId":"grant_edit","branchId":"branch_main","branchName":"main","role":"edit","expiresAt":null,"revokedAt":null,"createdAt":"2026-05-15T12:00:00.000Z","sessions":[]}]}"#)
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
    let grants = try await controller.listLinks()
    try await controller.revokeLink(grantId: editLink.grantId)

    #expect(document.docId == "doc_hosted")
    #expect(appEditorURL.absoluteString == "https://app.example.test/collab?docId=doc_hosted&branchId=branch_main&mode=edit&clientKind=app&nativeShell=markedit&localDocId=\(localDocId)")
    #expect(!appEditorURL.absoluteString.contains("token="))
    #expect(appEditorURL.fragment == nil)
    #expect(editLink.url.absoluteString == "https://app.example.test/collab?docId=doc_hosted&branchId=branch_main&token=ml_access_edit&mode=edit&filename=note.md")
    #expect(viewLink.url.absoluteString == "https://app.example.test/collab?docId=doc_hosted&branchId=branch_main&token=ml_access_view&mode=view&filename=note.md")
    #expect(grants.map(\.grantId) == ["grant_view", "grant_edit"])
    #expect(transport.requests.map(\.percentEncodedPath) == [
      "/api/docs/import",
      "/api/docs/doc_hosted/branches/branch_main/access-grants",
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

  @Test("uses existing version history routes for list show manual save autosave and restore")
  func usesExistingVersionHistoryRoutes() async throws {
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"versions":[{"versionId":"ver_002","parentVersionId":"ver_001","versionNumber":2,"hash":"sha256:b","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:00:00.000Z"},{"versionId":"ver_001","parentVersionId":null,"versionNumber":1,"hash":"sha256:a","actorType":"system","actorId":null,"operation":"import","createdAt":"2026-05-22T11:00:00.000Z"}]}"#)
    transport.enqueue(json: ##"{"versionId":"ver_002","branchId":"branch_main","parentVersionId":"ver_001","versionNumber":2,"markdown":"# Saved\n","hash":"sha256:b","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:00:00.000Z"}"##)
    transport.enqueue(json: #"{"created":true,"versionId":"ver_003","versionNumber":3,"hash":"sha256:c"}"#)
    transport.enqueue(json: #"{"created":false,"versionId":"ver_003","versionNumber":3,"hash":"sha256:c"}"#)
    transport.enqueue(json: #"{"versionId":"ver_004","versionNumber":4,"hash":"sha256:d"}"#)
    let client = NativeControlPlaneShareClient(
      apiBaseURL: URL(string: "https://api.example.test")!,
      webBaseURL: URL(string: "https://app.example.test")!,
      bearerToken: "ml_user_session",
      workspaceId: "workspace_1",
      transport: transport
    )
    let controller = NativeHostedShareController(client: client)
    controller.restoreSharedDocument(
      from: NativeSharedDocumentBinding(
        fileURL: URL(fileURLWithPath: "/tmp/note.md"),
        document: NativeHostedDocument(
          docId: "doc_hosted",
          branchId: "branch_main",
          versionId: "version_1",
          hash: "sha256:hosted"
        ),
        appEditorURL: URL(string: "https://app.example.test/collab?docId=doc_hosted&branchId=branch_main")!,
        baselineMarkdown: "# Base\n"
      )
    )

    let versions = try await controller.listVersions()
    let snapshot = try await controller.showVersion(versionId: "ver_002")
    let manualSave = try await controller.saveVersion()
    let autosave = try await controller.autosaveVersion()
    let restore = try await controller.restoreVersion(versionId: "ver_002")

    #expect(versions.map(\.versionId) == ["ver_002", "ver_001"])
    #expect(versions.first?.operation == .manualSave)
    #expect(snapshot.markdown == "# Saved\n")
    #expect(snapshot.branchId == "branch_main")
    #expect(manualSave.created)
    #expect(manualSave.versionId == "ver_003")
    #expect(!autosave.created)
    #expect(autosave.versionId == "ver_003")
    #expect(restore.versionId == "ver_004")
    #expect(transport.requests.map { "\($0.method) \($0.percentEncodedPath)" } == [
      "GET /api/docs/doc_hosted/branches/branch_main/versions",
      "GET /api/docs/doc_hosted/versions/ver_002",
      "POST /api/docs/doc_hosted/branches/branch_main/versions/manual-save",
      "POST /api/docs/doc_hosted/branches/branch_main/versions/autosave",
      "POST /api/docs/doc_hosted/branches/branch_main/restore",
    ])
    #expect(transport.requests.allSatisfy { $0.authorization == "Bearer ml_user_session" })
    #expect(try #require(transport.requests[4].jsonBody)["versionId"] as? String == "ver_002")
  }

  @Test("maps version history HTTP failures into explicit native errors")
  func mapsVersionHistoryHTTPFailuresIntoExplicitNativeErrors() async throws {
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"error":"forbidden"}"#, statusCode: 403)
    transport.enqueue(json: #"{"error":"version_not_found"}"#, statusCode: 404)
    transport.enqueue(json: #"{"error":"live_writer_not_configured"}"#, statusCode: 503)
    let client = NativeControlPlaneShareClient(
      apiBaseURL: URL(string: "https://api.example.test")!,
      webBaseURL: URL(string: "https://app.example.test")!,
      bearerToken: "ml_user_session",
      workspaceId: "workspace_1",
      transport: transport
    )
    let document = NativeHostedDocument(
      docId: "doc_hosted",
      branchId: "branch_main",
      versionId: "version_1",
      hash: "sha256:hosted"
    )

    await #expect(throws: NativeVersionHistoryError.forbidden) {
      _ = try await client.listVersions(document: document)
    }
    await #expect(throws: NativeVersionHistoryError.staleOrMissingVersion) {
      _ = try await client.showVersion(document: document, versionId: "ver_missing")
    }
    await #expect(throws: NativeVersionHistoryError.unavailable) {
      _ = try await client.restoreVersion(document: document, versionId: "ver_002")
    }
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
