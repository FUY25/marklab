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
      hostedConfig: NativeCLIHostedConfig(
        apiBaseURL: "https://api.example.test",
        webBaseURL: "https://app.example.test",
        bearerToken: "ml_user_stale",
        workspaceId: "workspace_stale"
      ),
      createdAt: "1970-01-01T00:00:00.000Z"
    ))
    try store.writeResponse(.failure(
      requestId: "req_stale",
      code: "native_share_failed",
      message: "stale response"
    ))
    try store.writeRequest(NativeCLIShareRequest(
      requestId: "req_fresh",
      action: .share,
      file: "/tmp/fresh.md",
      role: .view,
      createdAt: "1970-01-01T00:19:30.000Z"
    ))

    #expect(try store.pendingRequestIds() == ["req_fresh"])
    #expect(try store.loadRequest(requestId: "req_stale") == nil)
    #expect(try store.loadResponse(requestId: "req_stale") == nil)
  }

  @Test("native CLI share request store skips malformed requests without blocking valid requests")
  func requestStoreSkipsMalformedPendingRequests() throws {
    let directory = try TemporaryDirectory()
    let store = FileNativeCLIShareRequestStore(
      appSupportDirectory: directory.url,
      maximumPendingRequestAge: 60,
      now: { Date(timeIntervalSince1970: 1_200) }
    )
    let requestsDirectory = directory.url.appending(path: "cli-requests", directoryHint: .isDirectory)
    let responsesDirectory = directory.url.appending(path: "cli-responses", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: requestsDirectory, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: responsesDirectory, withIntermediateDirectories: true)
    let malformedRequestURL = requestsDirectory.appending(path: "req_bad.json", directoryHint: .notDirectory)
    let malformedResponseURL = responsesDirectory.appending(path: "req_bad.json", directoryHint: .notDirectory)
    try Data(#"{ "requestId": "#.utf8).write(to: malformedRequestURL)
    try Data(#"{ "ok": false }"#.utf8).write(to: malformedResponseURL)
    try store.writeRequest(NativeCLIShareRequest(
      requestId: "req_fresh",
      action: .share,
      file: "/tmp/fresh.md",
      role: .edit,
      createdAt: "1970-01-01T00:19:30.000Z"
    ))

    #expect(try store.pendingRequestIds() == ["req_fresh"])
    #expect(FileManager.default.fileExists(atPath: malformedRequestURL.path))
    #expect(FileManager.default.fileExists(atPath: malformedResponseURL.path))

    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1_000)],
      ofItemAtPath: malformedRequestURL.path
    )
    #expect(try store.pendingRequestIds() == ["req_fresh"])
    #expect(!FileManager.default.fileExists(atPath: malformedRequestURL.path))
    #expect(!FileManager.default.fileExists(atPath: malformedResponseURL.path))
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
    let service = NativeCLIShareAppService(backgroundHost: backgroundHost) { _, _ in
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

  @MainActor
  @Test("native CLI share app service can use request-hosted config for an envless app process")
  func shareAppServiceUsesRequestHostedConfig() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "handoff.md")
    try Data("# Handoff\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_handoff","branchId":"branch_main","versionId":"version_1","hash":"sha256:handoff"}"#, statusCode: 201)
    transport.enqueue(json: #"{"grantId":"grant_edit","branchId":"branch_main","token":"ml_access_edit","role":"edit","expiresAt":null,"createdAt":"2026-05-19T12:00:00.000Z"}"#, statusCode: 201)
    let backgroundHost = MarkLabBackgroundSharedDocumentHost(createHiddenWindow: false)
    let service = NativeCLIShareAppService(
      backgroundHost: backgroundHost,
      makeHostedShareController: { config in
        guard
          let config,
          let apiURL = URL(string: config.apiBaseURL),
          let webURL = URL(string: config.webBaseURL)
        else {
          return nil
        }
        return NativeHostedShareController(client: NativeControlPlaneShareClient(
          apiBaseURL: apiURL,
          webBaseURL: webURL,
          bearerToken: config.bearerToken,
          workspaceId: config.workspaceId,
          transport: transport
        ))
      }
    ) { hostedShareController, nativeBearerToken in
      #expect(nativeBearerToken == "ml_user_from_cli")
      return MarkLabAppModel(
        hostedShareController: hostedShareController,
        baselineStore: InMemoryNativeProjectionBaselineStore(),
        conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
        sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
        sessionManager: NativeSharedDocumentSessionManager(),
        nativeBearerToken: nativeBearerToken
      )
    }

    let result = try await service.createShareLink(for: NativeCLIShareServiceRequest(
      fileURL: fileURL,
      role: .edit,
      hostedConfig: NativeCLIHostedConfig(
        apiBaseURL: "https://api.example.test",
        webBaseURL: "https://app.example.test",
        bearerToken: "ml_user_from_cli",
        workspaceId: "workspace_from_cli"
      )
    ))

    #expect(result.docId == "doc_handoff")
    #expect(result.link.url.absoluteString == "https://app.example.test/collab?docId=doc_handoff&branchId=branch_main&token=ml_access_edit&mode=edit&filename=handoff.md")
    #expect(transport.requests.map(\.authorization) == [
      "Bearer ml_user_from_cli",
      "Bearer ml_user_from_cli",
    ])
    #expect(transport.requests.first?.jsonBody?["workspaceId"] as? String == "workspace_from_cli")
  }

  @MainActor
  @Test("native CLI share app service replaces retained same-file model when request hosted config changes")
  func shareAppServiceUsesFreshHostedConfigForRetainedFile() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "rotating-token.md")
    try Data("# Rotating token\n".utf8).write(to: fileURL)
    let transport = TokenRotationHTTPTransport()
    let backgroundHost = MarkLabBackgroundSharedDocumentHost(createHiddenWindow: false)
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    let sessionManager = NativeSharedDocumentSessionManager()
    var createdModelCount = 0
    let service = NativeCLIShareAppService(
      backgroundHost: backgroundHost,
      makeHostedShareController: { config in
        guard
          let config,
          let apiURL = URL(string: config.apiBaseURL),
          let webURL = URL(string: config.webBaseURL)
        else {
          return nil
        }
        return NativeHostedShareController(client: NativeControlPlaneShareClient(
          apiBaseURL: apiURL,
          webBaseURL: webURL,
          bearerToken: config.bearerToken,
          workspaceId: config.workspaceId,
          transport: transport
        ))
      }
    ) { hostedShareController, nativeBearerToken in
      createdModelCount += 1
      return MarkLabAppModel(
        hostedShareController: hostedShareController,
        baselineStore: baselineStore,
        conflictStore: NativeConflictStore(directoryURL: directory.url.appending(
          path: "conflicts-\(createdModelCount)",
          directoryHint: .isDirectory
        )),
        sharedDocumentBindingStore: bindingStore,
        sessionManager: sessionManager,
        nativeBearerToken: nativeBearerToken
      )
    }

    let firstResult = try await service.createShareLink(for: NativeCLIShareServiceRequest(
      fileURL: fileURL,
      role: .edit,
      hostedConfig: NativeCLIHostedConfig(
        apiBaseURL: "https://api.example.test",
        webBaseURL: "https://app.example.test",
        bearerToken: "ml_user_first",
        workspaceId: "workspace_first"
      )
    ))
    let firstModel = try #require(backgroundHost.retainedModel(fileURL: fileURL))

    let secondResult = try await service.createShareLink(for: NativeCLIShareServiceRequest(
      fileURL: fileURL,
      role: .view,
      hostedConfig: NativeCLIHostedConfig(
        apiBaseURL: "https://api.example.test",
        webBaseURL: "https://app.example.test",
        bearerToken: "ml_user_second",
        workspaceId: "workspace_second"
      )
    ))
    let secondModel = try #require(backgroundHost.retainedModel(fileURL: fileURL))

    #expect(createdModelCount == 2)
    #expect(firstModel !== secondModel)
    #expect(firstResult.link.grantId == "grant_first")
    #expect(secondResult.link.grantId == "grant_second")
    let grantPosts = transport.requests.filter {
      $0.method == "POST" && $0.percentEncodedPath == "/api/docs/doc_rotating/branches/branch_main/access-grants"
    }
    #expect(grantPosts.map(\.authorization) == [
      "Bearer ml_user_first",
      "Bearer ml_user_second",
    ])
    #expect(transport.requests.first?.authorization == "Bearer ml_user_first")
    #expect(transport.requests.first?.percentEncodedPath == "/api/docs/import")
    #expect(grantPosts.map(\.percentEncodedPath) == [
      "/api/docs/doc_rotating/branches/branch_main/access-grants",
      "/api/docs/doc_rotating/branches/branch_main/access-grants",
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

private final class TokenRotationHTTPTransport: NativeHTTPTransport {
  private(set) var requests: [RecordedHTTPRequest] = []
  private var grantCount = 0

  func send(_ request: NativeHTTPRequest) async throws -> NativeHTTPResponse {
    requests.append(RecordedHTTPRequest(
      method: request.method,
      path: request.url.path,
      percentEncodedPath: URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? request.url.path,
      authorization: request.headers["Authorization"],
      nativeAppProof: request.headers["X-MarkLab-Native-App"],
      bodyString: request.body.map { String(decoding: $0, as: UTF8.self) } ?? ""
    ))
    if request.method == "POST", request.url.path == "/api/docs/import" {
      return jsonResponse(#"{"docId":"doc_rotating","branchId":"branch_main","versionId":"version_1","hash":"sha256:rotating"}"#, statusCode: 201)
    }
    if request.method == "POST", request.url.path == "/api/docs/doc_rotating/branches/branch_main/access-grants" {
      grantCount += 1
      if grantCount == 1 {
        return jsonResponse(#"{"grantId":"grant_first","branchId":"branch_main","token":"ml_access_first","role":"edit","expiresAt":null,"createdAt":"2026-05-19T12:00:00.000Z"}"#, statusCode: 201)
      }
      return jsonResponse(#"{"grantId":"grant_second","branchId":"branch_main","token":"ml_access_second","role":"view","expiresAt":null,"createdAt":"2026-05-19T12:01:00.000Z"}"#, statusCode: 201)
    }
    if request.method == "GET", request.url.path == "/api/docs/doc_rotating/branches/branch_main/access-grants" {
      return jsonResponse(#"{"grants":[]}"#)
    }
    throw NativeHTTPError.transport("unexpected test request \(request.method) \(request.url.path)")
  }

  private func jsonResponse(_ json: String, statusCode: Int = 200) -> NativeHTTPResponse {
    NativeHTTPResponse(
      statusCode: statusCode,
      data: Data(json.utf8),
      headers: ["content-type": "application/json"]
    )
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
