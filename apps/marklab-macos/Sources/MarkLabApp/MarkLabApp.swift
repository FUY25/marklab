import AppKit
import Darwin
import SwiftUI
import WebKit
import MarkLabMacOS

@main
struct MarkLabApp: App {
  var body: some Scene {
    WindowGroup("MarkLab") {
      MarkLabRootView(model: MarkLabAppModel(opensSelectedFilesInNewDocumentWindow: true))
    }
  }
}

struct PendingDiskIngestion: Equatable {
  let revision: Int
  let markdown: String
  let baselineMarkdown: String
  let conflictOnFailure: MarkLabConflict?
}

struct DiskIngestionBridgeResult: Equatable {
  let revision: Int
  let ok: Bool
  let markdown: String
  let baselineMarkdown: String
  let providerMarkdown: String?
  let reason: String?
}

@MainActor
final class MarkLabAppModel: ObservableObject {
  @Published var statusText = "Open a Markdown file to start local editing or sharing."
  @Published var latestLink: String?
  @Published var latestGrantId: String?
  @Published var embeddedCollabURL: URL?
  @Published var text = ""
  @Published var filePath: String?
  @Published var conflict: MarkLabConflict?
  @Published var pendingDiskIngestion: PendingDiskIngestion?
  @Published var localDaemonContext: NativeAppContext?
  @Published var resolvedConflictMarkdown = ""
  @Published var resolvedConflictConfirmation = ""

  private var document: LocalMarkdownDocument?
  private let hostedShareController: NativeHostedShareController?
  private let baselineStore: NativeProjectionBaselineStore
  private let conflictStore: NativeConflictStore
  let nativeBearerToken: String?
  private let beforeDiskIngestionReplace: (() -> Void)?
  private var nativeShareController: NativeShareController?
  private var lastProjectedMarkdown: String?
  private var pendingSharedMarkdown: String?
  private var projectionTask: Task<Void, Never>?
  private var diskIngestionRevision = 0
  private var fileWatcher: DispatchSourceFileSystemObject?
  let opensSelectedFilesInNewDocumentWindow: Bool

  init(
    hostedShareController: NativeHostedShareController? = MarkLabAppModel.makeHostedShareControllerFromEnvironment(),
    baselineStore: NativeProjectionBaselineStore = FileNativeProjectionBaselineStore.defaultStore(),
    conflictStore: NativeConflictStore = NativeConflictStore.defaultStore(),
    nativeBearerToken: String? = ProcessInfo.processInfo.environment["MARKLAB_USER_TOKEN"],
    beforeDiskIngestionReplace: (() -> Void)? = nil,
    opensSelectedFilesInNewDocumentWindow: Bool = false
  ) {
    self.hostedShareController = hostedShareController
    self.baselineStore = baselineStore
    self.conflictStore = conflictStore
    self.nativeBearerToken = nativeBearerToken
    self.beforeDiskIngestionReplace = beforeDiskIngestionReplace
    self.opensSelectedFilesInNewDocumentWindow = opensSelectedFilesInNewDocumentWindow
    if hostedShareController == nil {
      statusText = "Open a Markdown file. Sign in/workspace environment is required before sharing."
    }
  }

  deinit {
    fileWatcher?.cancel()
  }

  var actionsEnabled: Bool {
    hostedShareController != nil && document != nil && conflict == nil
  }

  var canResolveConflictThroughSharedEditor: Bool {
    guard let conflict else { return false }
    return embeddedCollabURL != nil || conflict.sharedEditorURL != nil
  }

  var canApplyResolvedConflictMarkdown: Bool {
    canResolveConflictThroughSharedEditor
      && !resolvedConflictMarkdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && resolvedConflictConfirmation == "APPLY RESOLVED"
  }

  func openFile() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.plainText]
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    if shouldOpenSelectedFileInNewDocumentWindow {
      switch MarkEditDocumentWindowCoordinator.shared.openDocumentWindow(fileURL: url) {
      case .opened:
        statusText = "Opened \(url.lastPathComponent) in a document window."
      case let .failed(statusText):
        self.statusText = statusText
      }
      return
    }
    loadFile(url)
  }

  var shouldOpenSelectedFileInNewDocumentWindow: Bool {
    opensSelectedFilesInNewDocumentWindow || filePath != nil
  }

  func loadFile(_ url: URL) {
    do {
      let opened = try LocalMarkdownDocument.open(fileURL: url, shared: false)
      document = opened
      text = opened.text
      filePath = url.path
      latestLink = nil
      latestGrantId = nil
      embeddedCollabURL = nil
      pendingDiskIngestion = nil
      localDaemonContext = nil
      nativeShareController = nil
      pendingSharedMarkdown = nil
      lastProjectedMarkdown = (try? baselineStore.loadBaseline(fileURL: url))?.lastProjectedMarkdown ?? opened.markdownForSave()
      if let persistedConflict = try? conflictStore.load(fileURL: url) {
        embeddedCollabURL = persistedConflict.sharedEditorURL
        setConflict(persistedConflict, status: "Conflict: review required before syncing resumes.")
      } else {
        clearConflictState()
        statusText = "Editing \(url.lastPathComponent)."
      }
      startFileWatcher(for: url)
    } catch {
      statusText = "Unable to open Markdown file."
    }
  }

  func saveFile() throws {
    if conflict != nil {
      statusText = "Resolve the conflict before saving."
      return
    }
    if embeddedCollabURL != nil {
      try flushPendingSharedProjection()
      return
    }
    guard var currentDocument = document else { return }
    currentDocument.replaceText(text)
    try currentDocument.save()
    document = currentDocument
    try updateProjectionBaseline(currentDocument.markdownForSave(), fileURL: currentDocument.fileURL)
    statusText = "Saved \(currentDocument.fileURL.lastPathComponent)."
  }

  func saveFileFromUI() {
    do {
      try saveFile()
    } catch {
      statusText = "Unable to save Markdown file."
    }
  }

  func startSharing() {
    guard conflict == nil else {
      statusText = "Resolve the conflict before sharing."
      return
    }
    guard let hostedShareController, let fileURL = document?.fileURL else { return }
    Task {
      do {
        try saveFile()
        let shared = try await hostedShareController.startSharing(fileURL: fileURL)
        latestLink = nil
        latestGrantId = nil
        embeddedCollabURL = try hostedShareController.appEditorURL()
        let sharedMarkdown = try LocalMarkdownDocument.open(fileURL: fileURL, shared: true).markdownForSave()
        try updateProjectionBaseline(sharedMarkdown, fileURL: fileURL)
        ensureCLILocalDaemonBoundary(fileURL: fileURL)
        statusText = "Shared \(fileURL.lastPathComponent) as \(shared.docId). App editor connected as workspace user."
      } catch {
        statusText = "Unable to start sharing."
      }
    }
  }

  func createLink(role: NativeLinkRole) {
    guard conflict == nil else {
      statusText = "Resolve the conflict before creating a link."
      return
    }
    guard let hostedShareController else { return }
    Task {
      do {
        let link = try await hostedShareController.createLink(role: role)
        latestLink = link.url.absoluteString
        latestGrantId = link.grantId
        statusText = "\(role.rawValue.capitalized) link created."
      } catch {
        statusText = "Unable to create \(role.rawValue) link."
      }
    }
  }

  func copyLatestLink() {
    guard let latestLink else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(latestLink, forType: .string)
    statusText = "Browser link copied."
  }

  func revokeLatestLink() {
    guard let hostedShareController, let latestGrantId else { return }
    Task {
      do {
        try await hostedShareController.revokeLink(grantId: latestGrantId)
        self.latestGrantId = nil
        self.latestLink = nil
        statusText = "Latest link revoked."
      } catch {
        statusText = "Unable to revoke latest link."
      }
    }
  }

  func restoreLatestVersion() {
    guard conflict == nil else {
      statusText = "Resolve the conflict before restoring a version."
      return
    }
    guard
      let nativeShareController,
      let versionId = localDaemonContext?.versions.first?.versionId
    else {
      return
    }
    Task {
      do {
        _ = try await nativeShareController.restoreVersion(versionId: versionId)
        localDaemonContext = try await nativeShareController.loadContext()
        statusText = "Restored local version \(versionId)."
      } catch {
        statusText = "Unable to restore local version."
      }
    }
  }

  func projectSharedMarkdownFromWebView(_ markdown: String) {
    receiveSharedMarkdownSnapshot(markdown)
  }

  func receiveSharedMarkdownSnapshot(_ markdown: String) {
    if let openConflict = conflict {
      text = markdown
      pendingSharedMarkdown = nil
      projectionTask?.cancel()
      if markdown != openConflict.sharedMarkdown {
        setConflict(
          MarkLabConflict(
            localMarkdown: openConflict.localMarkdown,
            sharedMarkdown: markdown,
            baselineMarkdown: openConflict.baselineMarkdown
          ),
          status: "Shared editor changed again. Review the updated conflict before resolving."
        )
      }
      return
    }
    pendingSharedMarkdown = markdown
    text = markdown
    projectionTask?.cancel()
    projectionTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        self?.flushPendingSharedProjectionFromTimer()
      }
    }
  }

  func flushPendingSharedProjectionFromTimer() {
    do {
      try flushPendingSharedProjection()
    } catch {
      statusText = "Unable to project shared Markdown to disk."
    }
  }

  func flushPendingSharedProjection() throws {
    guard let markdown = pendingSharedMarkdown else { return }
    try projectSharedMarkdownImmediately(markdown)
    pendingSharedMarkdown = nil
  }

  func projectSharedMarkdownImmediately(_ markdown: String) throws {
    guard var currentDocument = document else { return }
    let diskDocument = try LocalMarkdownDocument.open(fileURL: currentDocument.fileURL, shared: true)
    let diskMarkdown = diskDocument.markdownForSave()
    if let lastProjectedMarkdown,
       diskMarkdown != lastProjectedMarkdown,
       diskMarkdown != markdown {
      setConflict(
        MarkLabConflict(
          localMarkdown: diskMarkdown,
          sharedMarkdown: markdown,
          baselineMarkdown: lastProjectedMarkdown
        ),
        status: "Conflict: local file changed outside MarkLab while collaboration changed."
      )
      return
    }
    currentDocument.replaceText(markdown)
    try currentDocument.save()
    document = currentDocument
    text = markdown
    try updateProjectionBaseline(currentDocument.markdownForSave(), fileURL: currentDocument.fileURL)
    statusText = "Projected shared Markdown to \(currentDocument.fileURL.lastPathComponent)."
  }

  func ingestExternalFileChanges() {
    guard embeddedCollabURL != nil, let currentDocument = document, conflict == nil else { return }
    do {
      let diskDocument = try LocalMarkdownDocument.open(fileURL: currentDocument.fileURL, shared: true)
      let diskMarkdown = diskDocument.markdownForSave()
      guard diskMarkdown != lastProjectedMarkdown else { return }
      if let lastProjectedMarkdown,
         text != lastProjectedMarkdown,
         diskMarkdown != text {
        setConflict(
          MarkLabConflict(
            localMarkdown: diskMarkdown,
            sharedMarkdown: text,
            baselineMarkdown: lastProjectedMarkdown
          ),
          status: "Conflict: local file changed outside MarkLab while collaboration changed."
        )
        return
      }
      diskIngestionRevision += 1
      pendingDiskIngestion = PendingDiskIngestion(
        revision: diskIngestionRevision,
        markdown: diskMarkdown,
        baselineMarkdown: lastProjectedMarkdown ?? text,
        conflictOnFailure: nil
      )
      document = diskDocument
      statusText = "Queued local disk change for the shared editor."
    } catch {
      statusText = "Unable to ingest local disk change."
    }
  }

  func keepSharedConflictVersion() {
    guard let conflict else { return }
    guard ensureConflictSharedEditorAvailable() else {
      statusText = "Open the shared editor before resolving this conflict."
      return
    }
    guard refreshConflictIfDiskChanged(conflict, sharedMarkdown: conflict.sharedMarkdown) else { return }
    queueConflictMarkdownForSharedEditor(conflict.sharedMarkdown, fallbackConflict: conflict)
  }

  func acceptLocalConflictVersion() {
    guard let conflict else { return }
    guard ensureConflictSharedEditorAvailable() else {
      statusText = "Open the shared editor before resolving this conflict."
      return
    }
    guard refreshConflictIfDiskChanged(conflict, sharedMarkdown: conflict.sharedMarkdown) else { return }
    queueConflictMarkdownForSharedEditor(conflict.localMarkdown, fallbackConflict: conflict)
  }

  func resolveConflictWithMergedMarkdown() {
    guard let conflict else { return }
    guard ensureConflictSharedEditorAvailable() else {
      statusText = "Open the shared editor before resolving this conflict."
      return
    }
    guard refreshConflictIfDiskChanged(conflict, sharedMarkdown: conflict.sharedMarkdown) else { return }
    let markdown = resolvedConflictMarkdown
    guard canApplyResolvedConflictMarkdown else {
      statusText = "Paste resolved Markdown and type APPLY RESOLVED before applying it."
      return
    }
    queueConflictMarkdownForSharedEditor(markdown, fallbackConflict: conflict)
  }

  private func queueConflictMarkdownForSharedEditor(_ markdown: String, fallbackConflict conflict: MarkLabConflict) {
    diskIngestionRevision += 1
    pendingDiskIngestion = PendingDiskIngestion(
      revision: diskIngestionRevision,
      markdown: markdown,
      baselineMarkdown: conflict.sharedMarkdown,
      conflictOnFailure: conflict
    )
    statusText = "Queued conflict resolution for the shared editor."
  }

  private func ensureConflictSharedEditorAvailable() -> Bool {
    if embeddedCollabURL != nil { return true }
    if let url = conflict?.sharedEditorURL {
      embeddedCollabURL = url
      return true
    }
    return false
  }

  func handleDiskIngestionBridgeResult(_ result: DiskIngestionBridgeResult) {
    guard let pending = pendingDiskIngestion, pending.revision == result.revision else { return }
    if result.ok {
      if let fileURL = document?.fileURL {
        do {
          if let conflictOnFailure = pending.conflictOnFailure,
             !refreshConflictIfDiskChanged(conflictOnFailure, sharedMarkdown: result.markdown) {
            pendingDiskIngestion = nil
            return
          }
          if var currentDocument = document {
            let expectedDiskMarkdown = pending.conflictOnFailure?.localMarkdown ?? result.markdown
            currentDocument.replaceText(result.markdown)
            let saved = try currentDocument.saveIfCurrentMarkdownMatches(
              expectedDiskMarkdown,
              beforeReplace: beforeDiskIngestionReplace
            )
            guard saved else {
              handleDiskChangedDuringIngestionCommit(pending: pending, result: result)
              pendingDiskIngestion = nil
              return
            }
            document = currentDocument
          }
          text = result.markdown
          try updateProjectionBaseline(result.markdown, fileURL: fileURL)
        } catch {
          if let conflictOnFailure = pending.conflictOnFailure {
            setConflict(conflictOnFailure, status: "Unable to persist local disk change.")
          }
          statusText = "Unable to persist local disk change."
          return
        }
      } else {
        text = result.markdown
        lastProjectedMarkdown = result.markdown
      }
      pendingDiskIngestion = nil
      clearConflictState()
      statusText = "Ingested local disk change into the shared editor."
      return
    }
    if result.reason == "provider_changed", let providerMarkdown = result.providerMarkdown {
      setConflict(
        MarkLabConflict(
          localMarkdown: result.markdown,
          sharedMarkdown: providerMarkdown,
          baselineMarkdown: result.baselineMarkdown
        ),
        status: "Conflict: local file changed outside MarkLab while collaboration changed."
      )
      pendingDiskIngestion = nil
      return
    }
    if let conflictOnFailure = pending.conflictOnFailure {
      setConflict(conflictOnFailure, status: "Shared editor is not ready to accept the local conflict version.")
      pendingDiskIngestion = nil
      return
    }
    statusText = "Waiting to ingest local disk change into the shared editor."
  }

  private func refreshConflictIfDiskChanged(_ conflict: MarkLabConflict, sharedMarkdown: String) -> Bool {
    guard let currentDocument = document else { return true }
    do {
      let diskDocument = try LocalMarkdownDocument.open(fileURL: currentDocument.fileURL, shared: true)
      let diskMarkdown = diskDocument.markdownForSave()
      if diskMarkdown == conflict.localMarkdown { return true }
      setConflict(
        MarkLabConflict(
          localMarkdown: diskMarkdown,
          sharedMarkdown: sharedMarkdown,
          baselineMarkdown: conflict.baselineMarkdown
        ),
        status: "Local file changed again. Review the updated conflict before resolving."
      )
      return false
    } catch {
      statusText = "Unable to verify local file before resolving conflict."
      return false
    }
  }

  private func handleDiskChangedDuringIngestionCommit(
    pending: PendingDiskIngestion,
    result: DiskIngestionBridgeResult
  ) {
    if let conflictOnFailure = pending.conflictOnFailure {
      if refreshConflictIfDiskChanged(conflictOnFailure, sharedMarkdown: result.markdown) {
        setConflict(conflictOnFailure, status: "Unable to persist local disk change.")
      }
      return
    }
    guard let currentDocument = document else {
      statusText = "Unable to persist local disk change."
      return
    }
    do {
      let diskDocument = try LocalMarkdownDocument.open(fileURL: currentDocument.fileURL, shared: true)
      setConflict(
        MarkLabConflict(
          localMarkdown: diskDocument.markdownForSave(),
          sharedMarkdown: result.markdown,
          baselineMarkdown: result.baselineMarkdown
        ),
        status: "Local file changed again. Review the updated conflict before resolving."
      )
    } catch {
      statusText = "Unable to verify local file before resolving conflict."
    }
  }

  private func ensureCLILocalDaemonBoundary(fileURL: URL) {
    let environment = ProcessInfo.processInfo.environment
    guard environment["MARKLAB_APP_SKIP_LOCAL_DAEMON"] != "1" else { return }
    let command = environment["MARKLAB_CLI_COMMAND"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    let cliCommand = command?.isEmpty == false ? command! : "marklab"
    let registryURL = MarkLabAppModel.daemonRegistryURL(environment: environment)
    Task.detached { [weak self] in
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = [cliCommand, "share", fileURL.path, "--json", "--daemon-only"]
      process.standardOutput = Pipe()
      process.standardError = Pipe()
      do {
        try process.run()
        process.waitUntilExit()
        await self?.connectLocalDaemonBoundary(fileURL: fileURL, registryURL: registryURL)
      } catch {
        // The hosted collaboration path is still usable if the optional local daemon bridge is unavailable.
      }
    }
  }

  private func setConflict(_ nextConflict: MarkLabConflict, status: String) {
    let persistedConflict = nextConflict.withSharedEditorURL(storableConflictSharedEditorURL(embeddedCollabURL))
    conflict = persistedConflict
    resolvedConflictMarkdown = ""
    resolvedConflictConfirmation = ""
    if let fileURL = document?.fileURL {
      try? conflictStore.save(persistedConflict, fileURL: fileURL)
    }
    statusText = status
  }

  private func storableConflictSharedEditorURL(_ url: URL?) -> URL? {
    guard let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    components.percentEncodedFragment = nil
    return components.url
  }

  private func clearConflictState() {
    if let fileURL = document?.fileURL {
      conflictStore.clear(fileURL: fileURL)
    }
    conflict = nil
    resolvedConflictMarkdown = ""
    resolvedConflictConfirmation = ""
  }

  private func updateProjectionBaseline(_ markdown: String, fileURL: URL) throws {
    try baselineStore.saveBaseline(
      NativeProjectionBaselineRecord(
        markdown: markdown,
        providerStateFingerprint: NativeProjectionBaselineRecord.providerYTextFingerprint(markdown)
      ),
      fileURL: fileURL
    )
    lastProjectedMarkdown = markdown
  }

  private func startFileWatcher(for fileURL: URL) {
    stopFileWatcher()
    let descriptor = open(fileURL.path, O_EVTONLY)
    guard descriptor >= 0 else { return }
    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: descriptor,
      eventMask: [.write, .extend, .attrib, .rename, .delete],
      queue: .main
    )
    source.setEventHandler { [weak self] in
      self?.ingestExternalFileChanges()
    }
    source.setCancelHandler {
      close(descriptor)
    }
    fileWatcher = source
    source.resume()
  }

  private func stopFileWatcher() {
    fileWatcher?.cancel()
    fileWatcher = nil
  }

  private func connectLocalDaemonBoundary(fileURL: URL, registryURL: URL) async {
    await MainActor.run {
      do {
        let registry = try NativeDaemonRegistry(fileURL: registryURL).read()
        let canonicalPath = NativeLocalDocumentIdentity.canonicalPath(fileURL: fileURL)
        guard let entry = registry.daemons.first(where: { $0.realpath == canonicalPath }) else { return }
        let controller = NativeShareController(
          daemonClient: NativeDaemonClient(apiBaseURL: entry.apiUrl, bearerToken: entry.token)
        )
        nativeShareController = controller
        if let hostedShareController {
          embeddedCollabURL = try? hostedShareController.appEditorURL()
        }
        Task {
          do {
            localDaemonContext = try await controller.loadContext()
            if let context = localDaemonContext {
              statusText = "Shared \(context.document.displayName). Local daemon boundary ready."
            }
          } catch {
            statusText = "Shared file, but local daemon context is unavailable."
          }
        }
      } catch {
        statusText = "Shared file, but local daemon registry is unavailable."
      }
    }
  }

  private static func daemonRegistryURL(environment: [String: String]) -> URL {
    if let override = environment["MARKLAB_LOCAL_DAEMON_REGISTRY_PATH"], !override.isEmpty {
      return URL(fileURLWithPath: override)
    }
    let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appending(path: "MarkLab", directoryHint: .isDirectory)
    return appSupport.appending(path: "local-daemons.json")
  }

  private static func makeHostedShareControllerFromEnvironment() -> NativeHostedShareController? {
    let environment = ProcessInfo.processInfo.environment
    guard
      let apiURLString = environment["MARKLAB_CONTROL_PLANE_API_URL"],
      let apiURL = URL(string: apiURLString),
      let webURLString = environment["MARKLAB_PUBLIC_WEB_URL"],
      let webURL = URL(string: webURLString),
      let token = environment["MARKLAB_USER_TOKEN"],
      !token.isEmpty,
      let workspaceId = environment["MARKLAB_WORKSPACE_ID"],
      !workspaceId.isEmpty
    else {
      return nil
    }
    return NativeHostedShareController(
      client: NativeControlPlaneShareClient(
        apiBaseURL: apiURL,
        webBaseURL: webURL,
        bearerToken: token,
        workspaceId: workspaceId
      )
    )
  }
}

struct MarkLabRootView: View {
  @StateObject var model: MarkLabAppModel

  var body: some View {
    MarkEditDocumentShellView(model: model)
  }
}

struct HostedCollabWebView: NSViewRepresentable {
  let url: URL
  let diskIngestion: PendingDiskIngestion?
  let nativeBearerToken: String?
  let onMarkdownSnapshot: (String) -> Void
  let onDiskIngestionResult: (DiskIngestionBridgeResult) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(
      expectedURL: url,
      onMarkdownSnapshot: onMarkdownSnapshot,
      onDiskIngestionResult: onDiskIngestionResult
    )
  }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    if let nativeBearerToken, !nativeBearerToken.isEmpty {
      configuration.userContentController.addUserScript(WKUserScript(
        source: HostedCollabWebView.authFetchUserScript(nativeBearerToken),
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
      ))
    }
    configuration.userContentController.add(context.coordinator, name: "marklabNative")
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.expectedURL = url
    context.coordinator.expectedOrigin = NativeHostedWebViewOrigin(url: url)
    if !HostedCollabWebView.sameNavigationURL(webView.url, url) {
      webView.load(URLRequest(url: url))
    }
    if let diskIngestion,
       context.coordinator.lastAppliedDiskIngestionRevision != diskIngestion.revision {
      context.coordinator.applyDiskIngestion(diskIngestion, in: webView)
    }
  }

  static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
    nsView.configuration.userContentController.removeScriptMessageHandler(forName: "marklabNative")
  }

  fileprivate static func javascriptStringLiteral(_ value: String) -> String {
    guard
      let data = try? JSONSerialization.data(withJSONObject: [value]),
      let arrayLiteral = String(data: data, encoding: .utf8),
      arrayLiteral.first == "[",
      arrayLiteral.last == "]"
    else {
      return "\"\""
    }
    return String(arrayLiteral.dropFirst().dropLast())
  }

  fileprivate static func authFetchUserScript(_ bearerToken: String) -> String {
    let escapedToken = javascriptStringLiteral(bearerToken)
    return """
    (() => {
      const marklabNativeBearerToken = \(escapedToken);
      window.__marklabNativeApp = true;
      const marklabNativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const rawUrl = typeof input === 'string' ? input : input.url;
        const target = new URL(rawUrl, window.location.href);
        if (target.origin === window.location.origin && target.pathname.startsWith('/api/')) {
          const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
          headers.set('Authorization', `Bearer ${marklabNativeBearerToken}`);
          headers.set('X-MarkLab-Native-App', '1');
          init = { ...init, headers };
        }
        return marklabNativeFetch(input, init);
      };
    })();
    """
  }

  fileprivate static func sameNavigationURL(_ current: URL?, _ expected: URL) -> Bool {
    guard let current else { return false }
    return current == expected
  }

  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let onMarkdownSnapshot: (String) -> Void
    private let onDiskIngestionResult: (DiskIngestionBridgeResult) -> Void
    var expectedURL: URL
    var expectedOrigin: NativeHostedWebViewOrigin
    var lastAppliedDiskIngestionRevision = 0
    private var retryCounts: [Int: Int] = [:]

    init(
      expectedURL: URL,
      onMarkdownSnapshot: @escaping (String) -> Void,
      onDiskIngestionResult: @escaping (DiskIngestionBridgeResult) -> Void
    ) {
      self.expectedURL = expectedURL
      self.expectedOrigin = NativeHostedWebViewOrigin(url: expectedURL)
      self.onMarkdownSnapshot = onMarkdownSnapshot
      self.onDiskIngestionResult = onDiskIngestionResult
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard message.name == "marklabNative" else { return }
      guard message.frameInfo.isMainFrame else { return }
      guard
        expectedOrigin.matches(
          scheme: message.frameInfo.securityOrigin.protocol,
          host: message.frameInfo.securityOrigin.host,
          port: message.frameInfo.securityOrigin.port
        ),
        nativeHostedWebViewURLIsAllowed(message.frameInfo.request.url ?? expectedURL, expectedURL: expectedURL)
      else {
        return
      }
      guard
        let body = message.body as? [String: Any],
        body["type"] as? String == "markdown-snapshot",
        let markdown = body["markdown"] as? String
      else {
        return
      }
      onMarkdownSnapshot(markdown)
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      guard let targetURL = navigationAction.request.url else {
        decisionHandler(.cancel)
        return
      }
      decisionHandler(nativeHostedWebViewURLIsAllowed(targetURL, expectedURL: expectedURL) ? .allow : .cancel)
    }

    func applyDiskIngestion(_ diskIngestion: PendingDiskIngestion, in webView: WKWebView) {
      let escapedMarkdown = HostedCollabWebView.javascriptStringLiteral(diskIngestion.markdown)
      let escapedBaseline = HostedCollabWebView.javascriptStringLiteral(diskIngestion.baselineMarkdown)
      webView.evaluateJavaScript(
        "window.__marklabNativeApplyDiskMarkdown && window.__marklabNativeApplyDiskMarkdown(\(escapedMarkdown), \(escapedBaseline));"
      ) { [weak self, weak webView] value, error in
        guard let self else { return }
        if let error {
          self.retryDiskIngestion(diskIngestion, in: webView, reason: error.localizedDescription)
          return
        }
        guard let result = value as? [String: Any], let ok = result["ok"] as? Bool else {
          self.retryDiskIngestion(diskIngestion, in: webView, reason: "native_bridge_unavailable")
          return
        }
        if ok {
          self.lastAppliedDiskIngestionRevision = diskIngestion.revision
          self.retryCounts.removeValue(forKey: diskIngestion.revision)
          self.onDiskIngestionResult(DiskIngestionBridgeResult(
            revision: diskIngestion.revision,
            ok: true,
            markdown: diskIngestion.markdown,
            baselineMarkdown: diskIngestion.baselineMarkdown,
            providerMarkdown: nil,
            reason: nil
          ))
          return
        }
        self.lastAppliedDiskIngestionRevision = diskIngestion.revision
        self.retryCounts.removeValue(forKey: diskIngestion.revision)
        self.onDiskIngestionResult(DiskIngestionBridgeResult(
          revision: diskIngestion.revision,
          ok: false,
          markdown: diskIngestion.markdown,
          baselineMarkdown: diskIngestion.baselineMarkdown,
          providerMarkdown: result["providerMarkdown"] as? String,
          reason: result["reason"] as? String
        ))
      }
    }

    private func retryDiskIngestion(_ diskIngestion: PendingDiskIngestion, in webView: WKWebView?, reason: String) {
      let attempts = (retryCounts[diskIngestion.revision] ?? 0) + 1
      retryCounts[diskIngestion.revision] = attempts
      guard attempts < 20, let webView else {
        onDiskIngestionResult(DiskIngestionBridgeResult(
          revision: diskIngestion.revision,
          ok: false,
          markdown: diskIngestion.markdown,
          baselineMarkdown: diskIngestion.baselineMarkdown,
          providerMarkdown: nil,
          reason: reason
        ))
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self, weak webView] in
        guard let self, let webView else { return }
        self.applyDiskIngestion(diskIngestion, in: webView)
      }
    }
  }
}
