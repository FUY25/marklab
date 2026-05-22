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
  @Test("app settings defaults changes refresh local autosave in open models")
  func appSettingsDefaultsChangesRefreshLocalAutosaveInOpenModels() async throws {
    let suiteName = "MarkLabAppModelTests.appSettingsAutosave.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer {
      defaults.removePersistentDomain(forName: suiteName)
    }
    let model = MarkLabAppModel(
      hostedShareController: nil,
      baselineStore: InMemoryNativeProjectionBaselineStore(),
      conflictStore: NativeConflictStore(directoryURL: URL(fileURLWithPath: NSTemporaryDirectory())),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      nativeBearerToken: nil,
      settingsDefaults: defaults
    )

    #expect(!model.localAutosaveEnabled)

    defaults.set(true, forKey: MarkLabAppSettings.localAutosaveEnabledDefaultsKey)
    NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
    await Task.yield()

    #expect(model.localAutosaveEnabled)

    defaults.set(false, forKey: MarkLabAppSettings.localAutosaveEnabledDefaultsKey)
    NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
    await Task.yield()

    #expect(!model.localAutosaveEnabled)
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
  @Test("loads previews saves and restores shared version history")
  func loadsPreviewsSavesAndRestoresSharedVersionHistory() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "versions.md")
    try Data("# Versions\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    let restoredHash = NativeProjectionBaselineRecord.markdownHash("# Version 3\n")
    transport.enqueue(json: #"{"docId":"doc_versions","branchId":"branch_main","versionId":"ver_001","hash":"sha256:one"}"#, statusCode: 201)
    transport.enqueue(json: #"{"created":false,"versionId":"ver_001","versionNumber":1,"hash":"sha256:one"}"#)
    transport.enqueue(json: #"{"versions":[{"versionId":"ver_002","parentVersionId":"ver_001","versionNumber":2,"hash":"sha256:two","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:00:00.000Z"}]}"#)
    transport.enqueue(json: ##"{"versionId":"ver_002","branchId":"branch_main","parentVersionId":"ver_001","versionNumber":2,"markdown":"# Version 2\n","hash":"sha256:two","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:00:00.000Z"}"##)
    transport.enqueue(json: #"{"created":true,"versionId":"ver_003","versionNumber":3,"hash":"sha256:three"}"#)
    transport.enqueue(json: #"{"versions":[{"versionId":"ver_003","parentVersionId":"ver_002","versionNumber":3,"hash":"sha256:three","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:05:00.000Z"}]}"#)
    transport.enqueue(json: ##"{"versionId":"ver_003","branchId":"branch_main","parentVersionId":"ver_002","versionNumber":3,"markdown":"# Version 3\n","hash":"sha256:three","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:05:00.000Z"}"##)
    transport.enqueue(json: #"{"versionId":"ver_004","versionNumber":4,"hash":"\#(restoredHash)"}"#)
    transport.enqueue(json: ##"{"versionId":"ver_004","branchId":"branch_main","parentVersionId":"ver_002","versionNumber":4,"markdown":"# Version 3\n","hash":"\##(restoredHash)","actorType":"user","actorId":"user_1","operation":"rollback","createdAt":"2026-05-22T12:06:00.000Z"}"##)
    transport.enqueue(json: #"{"versions":[{"versionId":"ver_004","parentVersionId":"ver_002","versionNumber":4,"hash":"\#(restoredHash)","actorType":"user","actorId":"user_1","operation":"rollback","createdAt":"2026-05-22T12:06:00.000Z"}]}"#)
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

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()
    await model.loadVersionHistory()

    #expect(model.versionHistory.map(\.versionId) == ["ver_002"])
    #expect(model.selectedVersionId == "ver_002")

    await model.previewVersion("ver_002")

    #expect(model.selectedVersion?.markdown == "# Version 2\n")
    #expect(!model.canApplySelectedVersionRestore)

    await model.saveVersionSnapshot()

    #expect(model.versionHistory.map(\.versionId) == ["ver_003"])
    #expect(model.selectedVersion?.markdown == "# Version 3\n")
    #expect(model.statusText == "Saved version 3.")

    model.restoreVersionConfirmation = "RESTORE"
    #expect(model.canApplySelectedVersionRestore)
    let restoreURLBefore = try #require(model.embeddedCollabURL)
    await model.restoreSelectedVersion()

    #expect(model.versionHistory.map(\.versionId) == ["ver_004"])
    #expect(model.selectedVersion?.markdown == "# Version 3\n")
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "# Version 3\n")
    #expect(model.embeddedCollabURL != restoreURLBefore)
    #expect(model.embeddedCollabURL?.query?.contains("nativeReload=") == true)
    #expect(model.restoreVersionConfirmation.isEmpty)
    #expect(model.statusText == "Restored version 4. The local file will update through shared projection.")
    #expect(transport.requests.map { "\($0.method) \($0.percentEncodedPath)" }.suffix(9) == [
      "POST /api/docs/doc_versions/branches/branch_main/versions/autosave",
      "GET /api/docs/doc_versions/branches/branch_main/versions",
      "GET /api/docs/doc_versions/versions/ver_002",
      "POST /api/docs/doc_versions/branches/branch_main/versions/manual-save",
      "GET /api/docs/doc_versions/branches/branch_main/versions",
      "GET /api/docs/doc_versions/versions/ver_003",
      "POST /api/docs/doc_versions/branches/branch_main/restore",
      "GET /api/docs/doc_versions/versions/ver_004",
      "GET /api/docs/doc_versions/branches/branch_main/versions",
    ])
  }

  @MainActor
  @Test("restore ignores stale queued shared projections after applying the selected version")
  func restoreCancelsStaleQueuedProjection() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "restore-race.md")
    try Data("# Before\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    let restoredHash = NativeProjectionBaselineRecord.markdownHash("# Restored\n")
    transport.enqueue(json: #"{"docId":"doc_restore_race","branchId":"branch_main","versionId":"ver_001","hash":"sha256:one"}"#, statusCode: 201)
    transport.enqueue(json: #"{"versionId":"ver_003","versionNumber":3,"hash":"\#(restoredHash)"}"#)
    transport.enqueue(json: ##"{"versionId":"ver_003","branchId":"branch_main","parentVersionId":"ver_001","versionNumber":3,"markdown":"# Restored\n","hash":"\##(restoredHash)","actorType":"user","actorId":"user_1","operation":"rollback","createdAt":"2026-05-22T12:06:00.000Z"}"##)
    transport.enqueue(json: #"{"versions":[{"versionId":"ver_003","parentVersionId":"ver_001","versionNumber":3,"hash":"\#(restoredHash)","actorType":"user","actorId":"user_1","operation":"rollback","createdAt":"2026-05-22T12:06:00.000Z"}]}"#)
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

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()
    model.selectedVersionId = "ver_001"
    model.selectedVersion = NativeDocumentVersionSnapshot(
      versionId: "ver_001",
      branchId: "branch_main",
      parentVersionId: nil,
      versionNumber: 1,
      markdown: "# Stale preview before restore\n",
      hash: "sha256:one",
      actorType: .system,
      actorId: nil,
      operation: .import,
      createdAt: "2026-05-22T12:00:00.000Z"
    )
    model.restoreVersionConfirmation = "RESTORE"
    model.receiveSharedMarkdownSnapshot("# Stale queued provider text\n")

    await model.restoreSelectedVersion()
    try await Task.sleep(nanoseconds: 2_200_000_000)

    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "# Restored\n")
    #expect(model.text == "# Restored\n")
  }

  @MainActor
  @Test("restore refuses to project a rollback snapshot whose markdown does not match the restored hash")
  func restoreRefusesMismatchedRollbackSnapshotHash() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "restore-hash.md")
    try Data("# Before\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_restore_hash","branchId":"branch_main","versionId":"ver_001","hash":"sha256:one"}"#, statusCode: 201)
    transport.enqueue(json: #"{"versionId":"ver_002","versionNumber":2,"hash":"sha256:not-the-markdown-hash"}"#)
    transport.enqueue(json: ##"{"versionId":"ver_002","branchId":"branch_main","parentVersionId":"ver_001","versionNumber":2,"markdown":"# Canonical rollback\n","hash":"sha256:not-the-markdown-hash","actorType":"user","actorId":"user_1","operation":"rollback","createdAt":"2026-05-22T12:06:00.000Z"}"##)
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

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()
    model.selectedVersionId = "ver_001"
    model.selectedVersion = NativeDocumentVersionSnapshot(
      versionId: "ver_001",
      branchId: "branch_main",
      parentVersionId: nil,
      versionNumber: 1,
      markdown: "# Source\n",
      hash: "sha256:one",
      actorType: .system,
      actorId: nil,
      operation: .import,
      createdAt: "2026-05-22T12:00:00.000Z"
    )
    model.restoreVersionConfirmation = "RESTORE"

    await model.restoreSelectedVersion()

    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "# Before\n")
    #expect(model.text == "# Before\n")
    #expect(model.statusText == "Unable to restore selected version.")
  }

  @MainActor
  @Test("preview ignores out-of-order version responses")
  func previewIgnoresOutOfOrderVersionResponses() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "preview-race.md")
    try Data("# Preview\n".utf8).write(to: fileURL)
    let transport = PathBlockingHTTPTransport()
    await transport.enqueue(json: #"{"docId":"doc_preview","branchId":"branch_main","versionId":"ver_001","hash":"sha256:one"}"#, statusCode: 201, pathContains: "/api/docs/import")
    await transport.enqueue(json: ##"{"versionId":"ver_slow","branchId":"branch_main","parentVersionId":"ver_001","versionNumber":2,"markdown":"# Slow\n","hash":"sha256:slow","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:00:00.000Z"}"##, pathContains: "/versions/ver_slow", blocks: true)
    await transport.enqueue(json: ##"{"versionId":"ver_fast","branchId":"branch_main","parentVersionId":"ver_001","versionNumber":3,"markdown":"# Fast\n","hash":"sha256:fast","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:01:00.000Z"}"##, pathContains: "/versions/ver_fast")
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

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()
    let slowPreview = Task { await model.previewVersion("ver_slow") }
    await transport.waitUntilBlocked()
    await model.previewVersion("ver_fast")
    await transport.releaseBlockedRequest()
    await slowPreview.value

    #expect(model.selectedVersionId == "ver_fast")
    #expect(model.selectedVersion?.versionId == "ver_fast")
    #expect(model.selectedVersion?.markdown == "# Fast\n")
  }

  @MainActor
  @Test("version history ignores stale list responses after opening another file")
  func versionHistoryIgnoresStaleListResponsesAfterFileSwitch() async throws {
    let directory = try TemporaryDirectory()
    let firstFileURL = directory.url.appending(path: "retained-a.md")
    let secondFileURL = directory.url.appending(path: "local-b.md")
    try Data("A\n".utf8).write(to: firstFileURL)
    try Data("B\n".utf8).write(to: secondFileURL)
    let link = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_retained_a&branchId=branch_main&token=ml_access_edit&mode=edit")
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    try bindingStore.saveBinding(
      NativeSharedDocumentBinding(
        fileURL: firstFileURL,
        link: link,
        appEditorURL: link.appEditorURL(localDocId: NativeLocalDocumentIdentity.localDocId(fileURL: firstFileURL)),
        baselineMarkdown: "A\n"
      ).withSyncEnabled(false),
      fileURL: firstFileURL
    )
    let transport = PathBlockingHTTPTransport()
    await transport.enqueue(
      json: #"{"versions":[{"versionId":"ver_stale","parentVersionId":null,"versionNumber":1,"hash":"sha256:stale","actorType":"system","actorId":null,"operation":"import","createdAt":"2026-05-22T12:00:00.000Z"}]}"#,
      pathContains: "/branches/branch_main/versions",
      blocks: true
    )
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

    model.loadFile(firstFileURL)
    let listTask = Task { await model.loadVersionHistory(createAutosaveCheckpoint: false) }
    await transport.waitUntilBlocked()
    model.loadFile(secondFileURL)
    await transport.releaseBlockedRequest()
    await listTask.value

    #expect(model.filePath == secondFileURL.path)
    #expect(!model.hasCloudCopyReference)
    #expect(model.versionHistory.isEmpty)
    #expect(model.selectedVersionId == nil)
  }

  @MainActor
  @Test("manual checkpoint aborts when pending shared projection opens a conflict")
  func manualCheckpointAbortsWhenProjectionOpensConflict() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "save-conflict.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_save_conflict","branchId":"branch_main","versionId":"ver_001","hash":"sha256:one"}"#, statusCode: 201)
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let model = MarkLabAppModel(
      hostedShareController: NativeHostedShareController(client: NativeControlPlaneShareClient(
        apiBaseURL: URL(string: "https://api.example.test")!,
        webBaseURL: URL(string: "https://app.example.test")!,
        bearerToken: "ml_user_session",
        workspaceId: "workspace_1",
        transport: transport
      )),
      baselineStore: baselineStore,
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: InMemoryNativeSharedDocumentBindingStore(),
      sessionManager: NativeSharedDocumentSessionManager(),
      nativeBearerToken: "ml_user_session"
    )

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()
    model.receiveSharedMarkdownSnapshot("Shared pending\n")
    try Data("External local edit\n".utf8).write(to: fileURL)

    await model.saveVersionSnapshot()

    #expect(model.conflict != nil)
    #expect(model.statusText == "Resolve the conflict before saving a version.")
    #expect(transport.requests.map { "\($0.method) \($0.percentEncodedPath)" } == [
      "POST /api/docs/import",
    ])
  }

  @MainActor
  @Test("delete cloud copy aborts when pending shared projection opens a conflict")
  func deleteCloudCopyAbortsWhenProjectionOpensConflict() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "delete-conflict.md")
    try Data("Base\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_delete_conflict","branchId":"branch_main","versionId":"ver_001","hash":"sha256:one"}"#, statusCode: 201)
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

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()
    model.receiveSharedMarkdownSnapshot("Shared pending\n")
    try Data("External local edit\n".utf8).write(to: fileURL)
    model.deleteCloudCopyConfirmation = "DELETE CLOUD COPY"

    await model.deleteCloudCopy()

    #expect(model.conflict != nil)
    #expect(model.hasSharedDocument)
    #expect(model.statusText == "Resolve the conflict before deleting the cloud copy.")
    #expect(transport.requests.map { "\($0.method) \($0.percentEncodedPath)" } == [
      "POST /api/docs/import",
    ])
  }

  @MainActor
  @Test("command save creates a manual checkpoint for shared documents")
  func commandSaveCreatesManualCheckpointForSharedDocuments() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "command-save.md")
    try Data("# Command save\n".utf8).write(to: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"docId":"doc_command_save","branchId":"branch_main","versionId":"ver_001","hash":"sha256:one"}"#, statusCode: 201)
    transport.enqueue(json: #"{"created":true,"versionId":"ver_002","versionNumber":2,"hash":"sha256:two"}"#)
    transport.enqueue(json: #"{"versions":[{"versionId":"ver_002","parentVersionId":"ver_001","versionNumber":2,"hash":"sha256:two","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:10:00.000Z"}]}"#)
    transport.enqueue(json: ##"{"versionId":"ver_002","branchId":"branch_main","parentVersionId":"ver_001","versionNumber":2,"markdown":"# Command save\n\nSaved with Cmd+S.\n","hash":"sha256:two","actorType":"user","actorId":"user_1","operation":"manual_save","createdAt":"2026-05-22T12:10:00.000Z"}"##)
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

    model.loadFile(fileURL)
    try await model.startSharingAndConnectThrowing()
    model.saveFileFromUI()
    try await waitForRecordedRequests(transport, count: 4)

    #expect(model.versionHistory.map(\.versionId) == ["ver_002"])
    #expect(model.selectedVersion?.markdown == "# Command save\n\nSaved with Cmd+S.\n")
    #expect(model.statusText == "Saved version 2.")
    #expect(transport.requests.map { "\($0.method) \($0.percentEncodedPath)" } == [
      "POST /api/docs/import",
      "POST /api/docs/doc_command_save/branches/branch_main/versions/manual-save",
      "GET /api/docs/doc_command_save/branches/branch_main/versions",
      "GET /api/docs/doc_command_save/versions/ver_002",
    ])
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
  @Test("delete cloud copy clears hosted state while keeping local markdown on disk")
  func deleteCloudCopyClearsHostedStateAndKeepsLocalMarkdown() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "delete-cloud.md")
    try Data("Local survivor\n".utf8).write(to: fileURL)
    let link = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_delete&branchId=branch_main&token=ml_access_edit&mode=edit")
    let baselineStore = InMemoryNativeProjectionBaselineStore()
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    try bindingStore.saveBinding(
      NativeSharedDocumentBinding(
        fileURL: fileURL,
        document: NativeHostedDocument(docId: "doc_delete", branchId: "branch_main", versionId: "version_1", hash: "sha256:host"),
        appEditorURL: link.appEditorURL(localDocId: NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)),
        baselineMarkdown: "Local survivor\n"
      ),
      fileURL: fileURL
    )
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"deleted":true,"docId":"doc_delete","branchIds":["branch_main"],"providerDocIds":["ml_doc_1"],"localFilePreserved":true}"#)
    transport.enqueue(json: #"{"grants":[]}"#)
    let model = MarkLabAppModel(
      hostedShareController: NativeHostedShareController(client: NativeControlPlaneShareClient(
        apiBaseURL: URL(string: "https://api.example.test")!,
        webBaseURL: URL(string: "https://app.example.test")!,
        bearerToken: "ml_user_session",
        workspaceId: "workspace_1",
        transport: transport
      )),
      baselineStore: baselineStore,
      conflictStore: NativeConflictStore(directoryURL: directory.url.appending(path: "conflicts", directoryHint: .isDirectory)),
      sharedDocumentBindingStore: bindingStore,
      nativeBearerToken: "ml_user_session"
    )

    model.loadFile(fileURL)
    model.deleteCloudCopyConfirmation = "DELETE CLOUD COPY"
    #expect(model.canDeleteCloudCopy)
    await model.deleteCloudCopy()

    #expect(!model.hasSharedDocument)
    #expect(model.managedAccessLinks.isEmpty)
    #expect(model.activeCollaborators.isEmpty)
    #expect(model.latestLink == nil)
    #expect(model.latestGrantId == nil)
    #expect(try String(contentsOf: fileURL, encoding: .utf8) == "Local survivor\n")
    #expect(try bindingStore.loadBinding(fileURL: fileURL) == nil)
    #expect(try baselineStore.loadBaseline(fileURL: fileURL) == nil)
    #expect(model.deleteCloudCopyConfirmation.isEmpty)
    #expect(model.statusText == "Deleted cloud copy for delete-cloud.md. Local file stays on disk.")
    #expect(transport.requests.filter { $0.method == "DELETE" }.map { "\($0.method) \($0.percentEncodedPath)" } == [
      "DELETE /api/docs/doc_delete/branches/branch_main/cloud-copy",
    ])
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
    #expect(model.retainedCloudCopyAvailable)
    #expect(model.managedAccessLinks.isEmpty)
    #expect(try bindingStore.loadBinding(fileURL: fileURL)?.syncEnabled == false)
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
    #expect(model.retainedCloudCopyAvailable)
    #expect(try bindingStore.loadBinding(fileURL: fileURL)?.syncEnabled == false)
    #expect(try baselineStore.loadBaseline(fileURL: fileURL) == nil)
    #expect(model.statusText == "Stopped sharing joined.md. Cloud copy and online versions are retained.")
  }

  @MainActor
  @Test("reopens stopped-sharing files with retained cloud version access but no active sync")
  func reopensStoppedSharingFilesWithRetainedCloudCopy() async throws {
    let directory = try TemporaryDirectory()
    let fileURL = directory.url.appending(path: "retained.md")
    try Data("Local only after stop\n".utf8).write(to: fileURL)
    let link = try NativeSharedDocumentLink.parse("https://app.example.test/collab?docId=doc_retained&branchId=branch_main&token=ml_access_edit&mode=edit")
    let bindingStore = InMemoryNativeSharedDocumentBindingStore()
    let activeBinding = NativeSharedDocumentBinding(
      fileURL: fileURL,
      link: link,
      appEditorURL: link.appEditorURL(localDocId: NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)),
      baselineMarkdown: "Local only after stop\n"
    )
    try bindingStore.saveBinding(activeBinding.withSyncEnabled(false), fileURL: fileURL)
    let transport = RecordingHTTPTransport()
    transport.enqueue(json: #"{"versions":[{"versionId":"ver_retained","parentVersionId":null,"versionNumber":1,"hash":"sha256:retained","actorType":"system","actorId":null,"operation":"import","createdAt":"2026-05-22T12:00:00.000Z"}]}"#)
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
    await model.loadVersionHistory(createAutosaveCheckpoint: false)

    #expect(!model.hasSharedDocument)
    #expect(model.retainedCloudCopyAvailable)
    #expect(model.versionHistory.map(\.versionId) == ["ver_retained"])
    #expect(transport.requests.map { "\($0.method) \($0.percentEncodedPath)" } == [
      "GET /api/docs/doc_retained/branches/branch_main/versions",
    ])
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
