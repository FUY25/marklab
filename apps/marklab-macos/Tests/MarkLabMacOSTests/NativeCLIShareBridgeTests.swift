import Foundation
import Testing
@testable import MarkLabApp
@testable import MarkLabMacOS

struct NativeCLIShareBridgeTests {
  @Test("native CLI share request store round-trips requests and responses")
  func requestStoreRoundTripsShareRequestsAndResponses() throws {
    let directory = try TemporaryDirectory()
    let store = FileNativeCLIShareRequestStore(appSupportDirectory: directory.url)
    let request = NativeCLIShareRequest(
      requestId: "req_1",
      action: .share,
      file: "/tmp/plan.md",
      role: .edit,
      createdAt: "2026-05-19T12:00:00Z"
    )

    try store.writeRequest(request)
    #expect(try store.loadRequest(requestId: "req_1") == request)

    let response = NativeCLIShareResponse.success(
      requestId: "req_1",
      file: "/tmp/plan.md",
      role: .edit,
      link: NativeHostedShareLink(
        grantId: "grant_1",
        role: .edit,
        url: URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=ml_access&mode=edit")!,
        expiresAt: nil,
        createdAt: "2026-05-19T12:00:00Z"
      ),
      docId: "doc_1",
      branchId: "branch_1",
      copied: true,
      opened: false
    )
    try store.writeResponse(response)
    #expect(try store.loadResponse(requestId: "req_1") == response)
  }

  @Test("native CLI join request store round-trips target file and link")
  func requestStoreRoundTripsJoinRequestsAndResponses() throws {
    let directory = try TemporaryDirectory()
    let store = FileNativeCLIShareRequestStore(appSupportDirectory: directory.url)
    let request = NativeCLIShareRequest(
      requestId: "req_join",
      action: .join,
      file: "/tmp/Host Notes.md",
      role: .edit,
      link: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=ml_access&mode=edit",
      createdAt: "2026-05-19T12:00:00Z"
    )

    try store.writeRequest(request)
    #expect(try store.loadRequest(requestId: "req_join") == request)

    let response = NativeCLIShareResponse.joinSuccess(
      requestId: "req_join",
      file: "/tmp/Host Notes.md",
      docId: "doc_1",
      branchId: "branch_1",
      opened: false
    )
    try store.writeResponse(response)
    #expect(try store.loadResponse(requestId: "req_join") == response)
  }

  @Test("native CLI share request store ignores stale pending requests")
  func requestStoreIgnoresStalePendingRequests() throws {
    let directory = try TemporaryDirectory()
    let store = FileNativeCLIShareRequestStore(
      appSupportDirectory: directory.url,
      maximumPendingRequestAge: 60,
      now: { Date(timeIntervalSince1970: 1_200) }
    )
    try store.writeRequest(NativeCLIShareRequest(
      requestId: "req_stale",
      action: .share,
      file: "/tmp/stale.md",
      role: .edit,
      createdAt: "1970-01-01T00:00:00.000Z"
    ))
    try store.writeRequest(NativeCLIShareRequest(
      requestId: "req_fresh",
      action: .share,
      file: "/tmp/fresh.md",
      role: .view,
      createdAt: "1970-01-01T00:19:30.000Z"
    ))

    #expect(try store.pendingRequestIds() == ["req_fresh"])
  }

  @MainActor
  @Test("native CLI share service serializes concurrent same-file requests")
  func nativeCLIShareServiceSerializesConcurrentSameFileRequests() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "same.md")
    try Data("# Same\n".utf8).write(to: fileURL)
    let transport = BlockingFirstHTTPTransport()
    await transport.enqueue(json: #"{"docId":"doc_same","branchId":"branch_main","versionId":"version_1","hash":"sha256:same"}"#, statusCode: 201)
    await transport.enqueue(json: #"{"grantId":"grant_edit","branchId":"branch_main","token":"ml_access_edit","role":"edit","expiresAt":null,"createdAt":"2026-05-19T12:00:00.000Z"}"#, statusCode: 201)
    await transport.enqueue(json: #"{"grantId":"grant_view","branchId":"branch_main","token":"ml_access_view","role":"view","expiresAt":null,"createdAt":"2026-05-19T12:01:00.000Z"}"#, statusCode: 201)
    let backgroundHost = MarkLabBackgroundSharedDocumentHost(createHiddenWindow: false)
    var createdModelCount = 0
    let service = NativeCLIShareAppService(backgroundHost: backgroundHost) {
      createdModelCount += 1
      return MarkLabAppModel(
        hostedShareController: NativeHostedShareController(client: NativeControlPlaneShareClient(
          apiBaseURL: URL(string: "https://api.example.test")!,
          webBaseURL: URL(string: "https://app.example.test")!,
          bearerToken: "ml_user_session",
          workspaceId: "workspace_1",
          transport: transport
        )),
        baselineStore: InMemoryNativeProjectionBaselineStore(),
        conflictStore: NativeConflictStore(directoryURL: directory.url.appending(
          path: "conflicts-\(createdModelCount)",
          directoryHint: .isDirectory
        )),
        sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
        sessionManager: NativeSharedDocumentSessionManager(),
        nativeBearerToken: "ml_user_session"
      )
    }

    async let editResult = service.createShareLink(for: NativeCLIShareServiceRequest(fileURL: fileURL, role: .edit))
    await transport.waitUntilFirstRequestStarted()
    async let viewResult = service.createShareLink(for: NativeCLIShareServiceRequest(fileURL: fileURL, role: .view))
    await transport.releaseFirstRequest()
    let results = try await [editResult, viewResult]

    #expect(createdModelCount == 1)
    #expect(results.map(\.docId) == ["doc_same", "doc_same"])
    #expect(results.map(\.link.role) == [.edit, .view])
    let requestPaths = await transport.requests.map(\.percentEncodedPath)
    #expect(requestPaths == [
      "/api/docs/import",
      "/api/docs/doc_same/branches/branch_main/access-grants",
      "/api/docs/doc_same/branches/branch_main/access-grants",
    ])
  }

  @Test("native CLI share processor delegates to native sharing and persists the response")
  @MainActor
  func processorDelegatesToNativeSharingAndPersistsResponse() async throws {
    let directory = try TemporaryDirectory()
    let store = FileNativeCLIShareRequestStore(appSupportDirectory: directory.url)
    let sharer = RecordingNativeCLIShareService()
    let processor = NativeCLIShareRequestProcessor(store: store, shareService: sharer)
    try store.writeRequest(NativeCLIShareRequest(
      requestId: "req_edit",
      action: .share,
      file: "/tmp/native.md",
      role: .edit,
      createdAt: "2026-05-19T12:00:00Z"
    ))

    try await processor.process(requestId: "req_edit")

    #expect(sharer.requests == [NativeCLIShareServiceRequest(fileURL: URL(fileURLWithPath: "/tmp/native.md"), role: .edit)])
    let response = try #require(try store.loadResponse(requestId: "req_edit"))
    #expect(response.ok)
    #expect(response.url == "https://app.example.test/collab?docId=doc_cli&branchId=branch_main&token=ml_access_edit&mode=edit")
    #expect(response.copied)
    #expect(response.grantId == "grant_edit")
  }

  @Test("native CLI share processor delegates hosted joins and persists the response")
  @MainActor
  func processorDelegatesHostedJoinAndPersistsResponse() async throws {
    let directory = try TemporaryDirectory()
    let store = FileNativeCLIShareRequestStore(appSupportDirectory: directory.url)
    let sharer = RecordingNativeCLIShareService()
    let processor = NativeCLIShareRequestProcessor(store: store, shareService: sharer)
    let link = "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit"
    try store.writeRequest(NativeCLIShareRequest(
      requestId: "req_join",
      action: .join,
      file: "/tmp/Host Notes.md",
      role: .edit,
      link: link,
      createdAt: "2026-05-19T12:00:00Z"
    ))

    try await processor.process(requestId: "req_join")

    #expect(sharer.joinRequests == [
      NativeCLIJoinServiceRequest(link: link, fileURL: URL(fileURLWithPath: "/tmp/Host Notes.md")),
    ])
    let response = try #require(try store.loadResponse(requestId: "req_join"))
    #expect(response.ok)
    #expect(response.action == "native_join_started")
    #expect(response.file == "/tmp/Host Notes.md")
    #expect(response.docId == "doc_join")
    #expect(response.branchId == "branch_main")
  }

  @MainActor
  @Test("native CLI share pump processes pending requests without relaunch arguments")
  func pumpProcessesPendingRequestsForAlreadyRunningApp() async throws {
    let directory = try TemporaryDirectory()
    let store = FileNativeCLIShareRequestStore(appSupportDirectory: directory.url, maximumPendingRequestAge: 0)
    let sharer = RecordingNativeCLIShareService()
    let processor = NativeCLIShareRequestProcessor(store: store, shareService: sharer)
    let pump = NativeCLIShareRequestPump(store: store, processor: processor)
    try store.writeRequest(NativeCLIShareRequest(
      requestId: "req_running",
      action: .share,
      file: "/tmp/running.md",
      role: .view,
      createdAt: "2026-05-19T12:00:00Z"
    ))

    try await pump.processPendingRequests()

    #expect(try store.pendingRequestIds() == [])
    let response = try #require(try store.loadResponse(requestId: "req_running"))
    #expect(response.ok)
    #expect(response.role == .view)
    #expect(response.grantId == "grant_view")
  }
}

final class RecordingNativeCLIShareService: NativeCLIShareService {
  private(set) var requests: [NativeCLIShareServiceRequest] = []
  private(set) var joinRequests: [NativeCLIJoinServiceRequest] = []

  func createShareLink(for request: NativeCLIShareServiceRequest) async throws -> NativeCLIShareServiceResult {
    requests.append(request)
    return NativeCLIShareServiceResult(
      link: NativeHostedShareLink(
        grantId: "grant_\(request.role.rawValue)",
        role: request.role,
        url: URL(string: "https://app.example.test/collab?docId=doc_cli&branchId=branch_main&token=ml_access_\(request.role.rawValue)&mode=\(request.role.rawValue)")!,
        expiresAt: nil,
        createdAt: "2026-05-19T12:00:00Z"
      ),
      docId: "doc_cli",
      branchId: "branch_main",
      copied: true,
      opened: false
    )
  }

  func joinSharedDocument(for request: NativeCLIJoinServiceRequest) async throws -> NativeCLIJoinServiceResult {
    joinRequests.append(request)
    let parsed = try NativeSharedDocumentLink.parse(request.link)
    return NativeCLIJoinServiceResult(docId: parsed.docId, branchId: parsed.branchId, opened: false)
  }
}
