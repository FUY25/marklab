import Foundation
import Testing
@testable import MarkLabApp
@testable import MarkLabMacOS

@Suite("MarkLab app model")
struct MarkLabAppModelTests {
  @MainActor
  @Test("legacy local daemon boundary is opt-in for the new relay app")
  func legacyLocalDaemonBoundaryIsOptIn() {
    #expect(!MarkLabAppModel.localDaemonBoundaryEnabled(environment: [:]))
    #expect(MarkLabAppModel.localDaemonBoundaryEnabled(environment: [
      "MARKLAB_APP_ENABLE_LOCAL_DAEMON_BOUNDARY": "1",
    ]))
    #expect(!MarkLabAppModel.localDaemonBoundaryEnabled(environment: [
      "MARKLAB_APP_ENABLE_LOCAL_DAEMON_BOUNDARY": "1",
      "MARKLAB_APP_SKIP_LOCAL_DAEMON": "1",
    ]))
  }

  @MainActor
  @Test("created browser links report automatic clipboard copy")
  func createdBrowserLinksReportAutomaticClipboardCopy() {
    #expect(MarkLabAppModel.linkCopiedStatusText(role: .edit) == "Edit link copied to clipboard.")
    #expect(MarkLabAppModel.linkCopiedStatusText(role: .view) == "View link copied to clipboard.")
  }

  @MainActor
  @Test("joins an edit link as a local shared document without the legacy daemon")
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
    #expect(try baselineStore.loadBaseline(fileURL: fileURL)?.lastProjectedMarkdown == "")
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
    #expect(model.statusText == "Joined shared document doc_join.")
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
