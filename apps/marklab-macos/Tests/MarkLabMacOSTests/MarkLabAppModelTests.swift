import Foundation
import Testing
@testable import MarkLabApp
@testable import MarkLabMacOS

@Suite("MarkLab app model")
struct MarkLabAppModelTests {
  @MainActor
  @Test("created browser links report automatic clipboard copy")
  func createdBrowserLinksReportAutomaticClipboardCopy() {
    #expect(MarkLabAppModel.linkCopiedStatusText(role: .edit) == "Edit link copied to clipboard.")
    #expect(MarkLabAppModel.linkCopiedStatusText(role: .view) == "View link copied to clipboard.")
  }

  @MainActor
  @Test("shared shell disappearance retains the model for background sync")
  func sharedShellDisappearanceRetainsModelForBackgroundSync() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "root-window.md")
    try Data("# Root window\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_root","branchId":"branch_main","versionId":"version_1","hash":"sha256:root"}"#, statusCode: 201)
    let sessionManager = NativeSharedDocumentSessionManager()
    let backgroundHost = MarkLabBackgroundSharedDocumentHost(createHiddenWindow: false)
    let model = MarkLabAppModel(
      hostedShareController: NativeHostedShareController(client: NativeControlPlaneShareClient(
        apiBaseURL: URL(string: "https://api.example.test")!,
        webBaseURL: URL(string: "https://app.example.test")!,
        bearerToken: "ml_user_session",
        workspaceId: "workspace_1",
        transport: transport
      )),
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      sessionManager: sessionManager,
      nativeBearerToken: "ml_user_session"
    )

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()

    #expect(model.retainSharedDocumentForBackgroundIfNeeded(backgroundHost: backgroundHost))
    #expect(backgroundHost.retainedModel(fileURL: fileURL) === model)
    #expect(sessionManager.sessions.first?.hasOpenWindow == false)
  }

  @MainActor
  @Test("CLI share service retains a background shared-document model after creating a link")
  func cliShareServiceRetainsBackgroundModel() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "cli-share.md")
    try Data("# CLI share\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_cli","branchId":"branch_main","versionId":"version_1","hash":"sha256:cli"}"#, statusCode: 201)
    transport.enqueue(json: #"{"grantId":"grant_cli","branchId":"branch_main","token":"ml_access_edit","role":"edit","expiresAt":null,"createdAt":"2026-05-19T12:00:00.000Z"}"#, statusCode: 201)
    let backgroundHost = MarkLabBackgroundSharedDocumentHost(createHiddenWindow: false)
    let model = MarkLabAppModel(
      hostedShareController: NativeHostedShareController(client: NativeControlPlaneShareClient(
        apiBaseURL: URL(string: "https://api.example.test")!,
        webBaseURL: URL(string: "https://app.example.test")!,
        bearerToken: "ml_user_session",
        workspaceId: "workspace_1",
        transport: transport
      )),
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      sessionManager: NativeSharedDocumentSessionManager(),
      nativeBearerToken: "ml_user_session"
    )
    let service = NativeCLIShareAppService(model: model, backgroundHost: backgroundHost)

    _ = try await service.createShareLink(for: NativeCLIShareServiceRequest(fileURL: fileURL, role: .edit))

    #expect(backgroundHost.retainedFileURLs == [fileURL])
    #expect(backgroundHost.retainedModel(fileURL: fileURL) === model)
  }

  @MainActor
  @Test("CLI share service retains independent background models for different files")
  func cliShareServiceRetainsIndependentBackgroundModelsForDifferentFiles() async throws {
    let directory = try TemporaryDirectory()
    let firstFileURL = directory.url.appending(path: "first.md")
    let secondFileURL = directory.url.appending(path: "second.md")
    try Data("# First\n".utf8).write(to: firstFileURL)
    try Data("# Second\n".utf8).write(to: secondFileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_first","branchId":"branch_main","versionId":"version_1","hash":"sha256:first"}"#, statusCode: 201)
    transport.enqueue(json: #"{"grantId":"grant_first","branchId":"branch_main","token":"ml_access_first","role":"edit","expiresAt":null,"createdAt":"2026-05-19T12:00:00.000Z"}"#, statusCode: 201)
    transport.enqueue(json: #"{"docId":"doc_second","branchId":"branch_main","versionId":"version_2","hash":"sha256:second"}"#, statusCode: 201)
    transport.enqueue(json: #"{"grantId":"grant_second","branchId":"branch_main","token":"ml_access_second","role":"view","expiresAt":null,"createdAt":"2026-05-19T12:01:00.000Z"}"#, statusCode: 201)
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

    _ = try await service.createShareLink(for: NativeCLIShareServiceRequest(fileURL: firstFileURL, role: .edit))
    let firstModel = try #require(backgroundHost.retainedModel(fileURL: firstFileURL))
    _ = try await service.createShareLink(for: NativeCLIShareServiceRequest(fileURL: secondFileURL, role: .view))
    let secondModel = try #require(backgroundHost.retainedModel(fileURL: secondFileURL))

    #expect(createdModelCount == 2)
    #expect(firstModel !== secondModel)
    #expect(firstModel.filePath == firstFileURL.path)
    #expect(secondModel.filePath == secondFileURL.path)
    #expect(backgroundHost.retainedFileURLs == [firstFileURL, secondFileURL])
  }

  @MainActor
  @Test("failed native start sharing removes the pending menu-bar session")
  func failedStartSharingRemovesPendingMenuSession() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "failed-share.md")
    try Data("# Failed share\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"error":"internal_error"}"#, statusCode: 500)
    let sessionManager = NativeSharedDocumentSessionManager()
    let model = MarkLabAppModel(
      hostedShareController: NativeHostedShareController(client: NativeControlPlaneShareClient(
        apiBaseURL: URL(string: "https://api.example.test")!,
        webBaseURL: URL(string: "https://app.example.test")!,
        bearerToken: "ml_user_session",
        workspaceId: "workspace_1",
        transport: transport
      )),
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      sessionManager: sessionManager,
      nativeBearerToken: "ml_user_session"
    )

    model.loadFile(fileURL)
    await #expect(throws: Error.self) {
      try await model.startSharingAndConnectThrowing()
    }

    #expect(sessionManager.sessions.isEmpty)
  }

  @MainActor
  @Test("local autosave setting gates local-only disk saves")
  func localAutosaveSettingGatesLocalOnlyDiskSaves() throws {
    let suiteName = "MarkLabAppModelTests.localAutosave.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer {
      defaults.removePersistentDomain(forName: suiteName)
    }
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: baselineStore,
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      nativeBearerToken: nil,
      settingsDefaults: defaults
    )

    model.loadFile(fileURL)
    model.receiveLocalEditorMarkdown("Draft\n")

    #expect(!model.localAutosaveEnabled)
    #expect(try model.flushLocalAutosave() == false)
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Base\n")
    #expect(try baselineStore.loadBaseline(fileURL: fileURL) == nil)

    model.setLocalAutosaveEnabled(true)

    #expect(model.localAutosaveEnabled)
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Draft\n")
    #expect(try baselineStore.loadBaseline(fileURL: fileURL)?.lastProjectedMarkdown == "Draft\n")

    let remembered = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "remembered-conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      nativeBearerToken: nil,
      settingsDefaults: defaults
    )
    #expect(remembered.localAutosaveEnabled)
  }

  @MainActor
  @Test("local autosave setting does not write through shared-mode projection")
  func localAutosaveSettingDoesNotWriteThroughSharedModeProjection() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "joined.md")
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      nativeBearerToken: nil,
      localAutosaveEnabled: true
    )

    try model.joinSharedDocument(
      linkString: "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit&filename=joined.md",
      localFileURL: fileURL
    )
    model.receiveLocalEditorMarkdown("Should not save through local autosave\n")

    #expect(try model.flushLocalAutosave() == false)
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "")
  }

  @MainActor
  @Test("joins an edit link as a local shared document")
  func joinsEditLinkAsLocalSharedDocument() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "joined.md")
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: baselineStore,
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: bindingStore,
      nativeBearerToken: nil
    )

    try model.joinSharedDocument(
      linkString: "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit&filename=joined.md",
      localFileURL: fileURL
    )

    let localDocId = NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)
    #expect(FileManager.default.fileExists(atPath: fileURL.path))
    #expect(model.filePath == fileURL.path)
    #expect(model.hasSharedDocument)
    #expect(model.latestGrantId == nil)
    #expect(model.latestLink == "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit&filename=joined.md")
    #expect(model.embeddedCollabURL?.absoluteString == "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit&clientKind=app&nativeShell=markedit&localDocId=\(localDocId)&filename=joined.md")
    #expect(model.statusText == "Joined shared document doc_join. Waiting for shared content.")
    let binding = try #require(try bindingStore.loadBinding(fileURL: fileURL))
    #expect(binding.docId == "doc_join")
    #expect(binding.branchId == "branch_main")
    #expect(binding.token == "ml_access_edit")
    #expect(binding.localDocId == localDocId)
    #expect(try baselineStore.loadBaseline(fileURL: fileURL) == nil)
  }

  @MainActor
  @Test("persists host start-sharing binding for reopen and guest reconnect")
  func persistsHostStartSharingBinding() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "host.md")
    try Data("# Host\n\nBefore share\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_host","branchId":"branch_main","versionId":"version_1","hash":"sha256:host"}"#, statusCode: 201)
    transport.enqueue(json: #"{"grants":[]}"#)
    let hostedShareController = NativeHostedShareController(client: NativeControlPlaneShareClient(
      apiBaseURL: URL(string: "https://api.example.test")!,
      webBaseURL: URL(string: "https://app.example.test")!,
      bearerToken: "ml_user_session",
      workspaceId: "workspace_1",
      transport: transport
    ))
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let model = MarkLabAppModel(
      hostedShareController: hostedShareController,
      baselineStore: baselineStore,
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: bindingStore,
      nativeBearerToken: "ml_user_session"
    )

    model.loadFile(fileURL)
    await model.startSharingAndConnect()

    let localDocId = NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)
    let binding = try #require(try bindingStore.loadBinding(fileURL: fileURL))
    #expect(binding.docId == "doc_host")
    #expect(binding.branchId == "branch_main")
    #expect(binding.token == nil)
    #expect(binding.localDocId == localDocId)
    #expect(binding.appEditorURL.absoluteString == "https://app.example.test/collab?docId=doc_host&branchId=branch_main&mode=edit&clientKind=app&nativeShell=markedit&localDocId=\(localDocId)")
    #expect(model.embeddedCollabURL == binding.appEditorURL)

    let reopened = MarkLabAppModel(
      hostedShareController: hostedShareController,
      baselineStore: baselineStore,
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: bindingStore,
      nativeBearerToken: "ml_user_session"
    )
    transport.enqueue(json: #"{"grants":[]}"#)
    reopened.loadFile(fileURL)
    await Task.yield()

    #expect(reopened.embeddedCollabURL == binding.appEditorURL)
    #expect(reopened.statusText == "Joined shared document doc_host.")
  }

  @MainActor
  @Test("rehydrates joined shared document bindings when reopening the local file")
  func rehydratesJoinedSharedDocumentBinding() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "joined.md")
    try Data("Local mirror\n".utf8).write(to: fileURL)
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    let link = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit")
    let appEditorURL = link.appEditorURL(localDocId: NativeLocalDocumentIdentity.localDocId(fileURL: fileURL))
    try bindingStore.saveBinding(
      NativeSharedDocumentBinding(
        fileURL: fileURL,
        link: link,
        appEditorURL: appEditorURL,
        baselineMarkdown: "Local mirror\n"
      ),
      fileURL: fileURL
    )
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: bindingStore,
      nativeBearerToken: nil
    )

    model.loadFile(fileURL)

    #expect(model.text == "Local mirror\n")
    #expect(model.embeddedCollabURL == MarkLabAppModel.markEditNativeShellURL(appEditorURL))
    #expect(model.statusText == "Joined shared document doc_join. Waiting for shared content.")
  }

  @MainActor
  @Test("stop sharing refreshes and revokes server grants created before this app session")
  func stopSharingRevokesServerHydratedGrants() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "host.md")
    try Data("Shared before stop\n".utf8).write(to: fileURL)
    let link = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_host&branchId=branch_main&token=ml_access_edit&mode=edit")
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    try bindingStore.saveBinding(
      NativeSharedDocumentBinding(
        fileURL: fileURL,
        document: NativeHostedDocument(docId: "doc_host", branchId: "branch_main", versionId: "version_1", hash: "sha256:host"),
        appEditorURL: link.appEditorURL(localDocId: NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)),
        baselineMarkdown: "Shared before stop\n"
      ),
      fileURL: fileURL
    )
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"grants":[{"grantId":"grant_old","branchId":"branch_main","branchName":"main","role":"edit","expiresAt":null,"revokedAt":null,"createdAt":"2026-05-15T12:00:00.000Z","sessions":[]},{"grantId":"grant_new","branchId":"branch_main","branchName":"main","role":"view","expiresAt":null,"revokedAt":null,"createdAt":"2026-05-15T12:01:00.000Z","sessions":[]}]}"#)
    transport.enqueue(json: #"{"grants":[{"grantId":"grant_old","branchId":"branch_main","branchName":"main","role":"edit","expiresAt":null,"revokedAt":null,"createdAt":"2026-05-15T12:00:00.000Z","sessions":[]},{"grantId":"grant_new","branchId":"branch_main","branchName":"main","role":"view","expiresAt":null,"revokedAt":null,"createdAt":"2026-05-15T12:01:00.000Z","sessions":[]}]}"#)
    transport.enqueue(data: Data(), statusCode: 204)
    transport.enqueue(data: Data(), statusCode: 204)
    let model = MarkLabAppModel(
      hostedShareController: NativeHostedShareController(client: NativeControlPlaneShareClient(
        apiBaseURL: URL(string: "https://api.example.test")!,
        webBaseURL: URL(string: "https://app.example.test")!,
        bearerToken: "ml_user_session",
        workspaceId: "workspace_1",
        transport: transport
      )),
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: bindingStore,
      nativeBearerToken: "ml_user_session"
    )

    model.loadFile(fileURL)
    await model.stopSharingAndReturnToLocalEditing()

    let requestPaths = transport.requests.map(\.percentEncodedPath)
    #expect(requestPaths.contains("/api/docs/doc_host/branches/branch_main/access-grants"))
    #expect(requestPaths.contains("/api/access-grants/grant_old"))
    #expect(requestPaths.contains("/api/access-grants/grant_new"))
    #expect(!model.hasSharedDocument)
    #expect(model.managedAccessLinks.isEmpty)
    #expect(try bindingStore.loadBinding(fileURL: fileURL) == nil)
  }

  @Test("server-hydrated access links parse fractional ISO expiry")
  func serverHydratedAccessLinkParsesFractionalExpiry() {
    let link = NativeManagedAccessLink(grant: NativeHostedAccessGrantSummary(
      grantId: "grant_expired",
      role: .edit,
      branchId: "branch_main",
      expiresAt: "2000-01-01T00:00:00.000Z",
      revokedAt: nil,
      createdAt: "1999-12-31T23:59:00.000Z"
    ))

    #expect(link.status == .expired)
  }

  @MainActor
  @Test("stops sharing by returning a joined document to local-only editing")
  func stopsSharingAndReturnsToLocalOnlyEditing() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "joined.md")
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: baselineStore,
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: bindingStore,
      nativeBearerToken: nil
    )

    try model.joinSharedDocument(
      linkString: "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit",
      localFileURL: fileURL
    )
    model.receiveSharedMarkdownSnapshot("Shared before stop\n")
    model.managedAccessLinks = [
      NativeManagedAccessLink(link: NativeHostedShareLink(
        grantId: "grant_edit",
        role: .edit,
        url: URL(string: "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit")!,
        expiresAt: nil,
        createdAt: nil
      )),
    ]

    await model.stopSharingAndReturnToLocalEditing()

    #expect(!model.hasSharedDocument)
    #expect(model.managedAccessLinks.isEmpty)
    #expect(model.activeCollaborators.isEmpty)
    #expect(model.latestLink == nil)
    #expect(model.latestGrantId == nil)
    #expect(model.text == "Shared before stop\n")
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Shared before stop\n")
    #expect(try bindingStore.loadBinding(fileURL: fileURL) == nil)
    #expect(try baselineStore.loadBaseline(fileURL: fileURL) == nil)
    #expect(model.statusText == "Stopped sharing joined.md.")
  }

  @MainActor
  @Test("refuses local app join for view links and unbound non-empty files")
  func refusesUnsafeLocalJoinTargets() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "existing.md")
    try Data("Existing work\n".utf8).write(to: fileURL)
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      nativeBearerToken: nil
    )

    #expect(throws: NativeSharedDocumentLinkError.localJoinRequiresEditLink) {
      try model.joinSharedDocument(
        linkString: "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_view&mode=view",
        localFileURL: directory.url.appending(path: "view.md")
      )
    }
    #expect(throws: NativeSharedDocumentLinkError.localFileNotEmpty) {
      try model.joinSharedDocument(
        linkString: "https://app.example.test/collab?docId=doc_join&branchId=branch_main&token=ml_access_edit&mode=edit",
        localFileURL: fileURL
      )
    }
    #expect(throws: NativeSharedDocumentLinkError.missingAccessToken) {
      try model.joinSharedDocument(
        linkString: "https://app.example.test/collab?docId=doc_join&branchId=branch_main&mode=edit",
        localFileURL: directory.url.appending(path: "missing-token.md")
      )
    }
    #expect(model.filePath == nil)
  }

  @MainActor
  @Test("rehydrates persisted conflicts with their shared editor URL")
  func persistedConflictCanResolveAfterReload() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    let conflictStore = NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory))
    let sharedEditorURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&localDocId=local_1"))
    try Data("Local\n".utf8).write(to: fileURL)
    try conflictStore.save(
      MarkLabConflict(
        localMarkdown: "Local\n",
        sharedMarkdown: "Shared\n",
        baselineMarkdown: "Base\n",
        sharedEditorURL: sharedEditorURL
      ),
      fileURL: fileURL
    )
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: conflictStore,
      nativeBearerToken: nil
    )

    model.loadFile(fileURL)

    let normalizedURL = try #require(MarkLabAppModel.markEditNativeShellURL(sharedEditorURL))
    #expect(model.conflict?.sharedEditorURL == normalizedURL)
    #expect(model.embeddedCollabURL == normalizedURL)
    #expect(URLComponents(url: normalizedURL, resolvingAgainstBaseURL: false)?.queryItems?.contains(
      URLQueryItem(name: "nativeShell", value: "markedit")
    ) == true)
    #expect(model.canResolveConflictThroughSharedEditor)
  }

  @MainActor
  @Test("requires pasted resolved Markdown and explicit confirmation before native conflict apply")
  func resolvedConflictRequiresMarkdownAndConfirmation() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    let conflictStore = NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory))
    let sharedEditorURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app"))
    try Data("Local\n".utf8).write(to: fileURL)
    try conflictStore.save(
      MarkLabConflict(
        localMarkdown: "Local\n",
        sharedMarkdown: "Shared\n",
        baselineMarkdown: "Base\n",
        sharedEditorURL: sharedEditorURL
      ),
      fileURL: fileURL
    )
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: conflictStore,
      nativeBearerToken: nil
    )

    model.loadFile(fileURL)
    model.resolvedConflictMarkdown = ""
    model.resolvedConflictConfirmation = "APPLY RESOLVED"
    #expect(!model.canApplyResolvedConflictMarkdown)
    model.resolveConflictWithMergedMarkdown()
    #expect(model.pendingDiskIngestion == nil)
    #expect(model.statusText == "Paste resolved Markdown and type APPLY RESOLVED before applying it.")

    model.resolvedConflictMarkdown = "Merged\n"
    model.resolvedConflictConfirmation = ""
    #expect(!model.canApplyResolvedConflictMarkdown)
    model.resolveConflictWithMergedMarkdown()
    #expect(model.pendingDiskIngestion == nil)

    model.resolvedConflictConfirmation = "APPLY RESOLVED"
    #expect(model.canApplyResolvedConflictMarkdown)
    model.resolveConflictWithMergedMarkdown()

    let pending = try #require(model.pendingDiskIngestion)
    #expect(pending.markdown == "Merged\n")
    #expect(pending.baselineMarkdown == "Shared\n")
  }

  @MainActor
  @Test("native conflict exposes an explicit diff preview before resolution")
  func nativeConflictExposesDiffPreview() throws {
    let conflict = MarkLabConflict(
      localMarkdown: "Title\nLocal only\n",
      sharedMarkdown: "Title\nShared only\n",
      baselineMarkdown: "Title\n"
    )

    #expect(conflict.diffPreview.contains("- Local only"))
    #expect(conflict.diffPreview.contains("+ Shared only"))
  }

  @MainActor
  @Test("does not overwrite disk changes that land during native conflict commit")
  func nativeConflictResolutionDoesNotOverwriteDiskRace() throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "note.md")
    let conflictStore = NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory))
    let sharedEditorURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app"))
    try Data("Local conflict\n".utf8).write(to: fileURL)
    try conflictStore.save(
      MarkLabConflict(
        localMarkdown: "Local conflict\n",
        sharedMarkdown: "Shared conflict\n",
        baselineMarkdown: "Base\n",
        sharedEditorURL: sharedEditorURL
      ),
      fileURL: fileURL
    )
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: conflictStore,
      nativeBearerToken: nil,
      beforeDiskIngestionReplace: {
        try? Data("External race\n".utf8).write(to: fileURL)
      }
    )

    model.loadFile(fileURL)
    model.acceptLocalConflictVersion()
    let pending = try #require(model.pendingDiskIngestion)
    model.handleDiskIngestionBridgeResult(
      DiskIngestionBridgeResult(
        revision: pending.revision,
        ok: true,
        markdown: pending.markdown,
        baselineMarkdown: pending.baselineMarkdown,
        providerMarkdown: nil,
        reason: nil
      )
    )

    let diskMarkdown = try String(contentsOf: fileURL, encoding: .utf8)
    #expect(diskMarkdown == "External race\n")
    #expect(model.conflict?.localMarkdown == "External race\n")
    #expect(model.pendingDiskIngestion == nil)
    #expect(model.statusText == "Local file changed again. Review the updated conflict before resolving.")
  }
}
