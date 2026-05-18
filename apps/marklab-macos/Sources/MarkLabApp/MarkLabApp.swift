import AppKit
import Darwin
import SwiftUI
import WebKit
import MarkLabMacOS

@main
struct MarkLabApp: App {
  @NSApplicationDelegateAdaptor(MarkLabAppDelegate.self) private var appDelegate
  private let launchFileURL = MarkLabLaunchFile.url(from: CommandLine.arguments)

  var body: some Scene {
    WindowGroup("MarkLab") {
      MarkLabRootView(
        model: MarkLabAppModel(opensSelectedFilesInNewDocumentWindow: true),
        launchFileURL: launchFileURL
      )
    }
    .defaultSize(
      width: MarkEditShellDescriptor.current.defaultWindowMetrics.width,
      height: MarkEditShellDescriptor.current.defaultWindowMetrics.height
    )
    .commands {
      MarkLabFileCommands()
    }
  }
}

struct MarkLabFileCommands: Commands {
  @FocusedValue(\.markEditShellActions) private var shellActions

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("Open...") {
        shellActions?.open()
      }
      .keyboardShortcut("o", modifiers: .command)
      .disabled(shellActions == nil)

      Button("Open Shared Link...") {
        shellActions?.openSharedLink()
      }
      .disabled(shellActions == nil)
    }

    CommandGroup(replacing: .saveItem) {
      Button("Save") {
        shellActions?.save()
      }
      .keyboardShortcut("s", modifiers: .command)
      .disabled(shellActions?.canSave != true)
    }
  }
}

final class MarkLabAppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)

    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      guard let launchFileURL = MarkLabLaunchFile.url(from: CommandLine.arguments) else { return }
      guard !MarkLabLaunchFileCoordinator.isClaimed(launchFileURL) else { return }
      if case .opened = MarkEditDocumentWindowCoordinator.shared.openDocumentWindow(fileURL: launchFileURL) {
        _ = MarkLabLaunchFileCoordinator.claim(launchFileURL)
      }
    }
  }
}

enum MarkLabLaunchFile {
  private static let supportedMarkdownExtensions = Set(["md", "markdown", "mdown", "mkd"])

  static func url(from arguments: [String]) -> URL? {
    arguments.dropFirst().lazy.compactMap { argument -> URL? in
      guard !argument.hasPrefix("-") else { return nil }
      let url = URL(fileURLWithPath: argument)
      guard supportedMarkdownExtensions.contains(url.pathExtension.lowercased()) else { return nil }
      return url
    }.first
  }
}

@MainActor
enum MarkLabLaunchFileCoordinator {
  private static var claimedPath: String?

  static func claim(_ url: URL) -> Bool {
    guard claimedPath != url.path else { return false }
    claimedPath = url.path
    return true
  }

  static func isClaimed(_ url: URL) -> Bool {
    claimedPath == url.path
  }

  static func resetForTesting() {
    claimedPath = nil
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

enum NativeManagedAccessLinkStatus: String, Equatable {
  case active
  case revoked
  case expired

  var label: String {
    rawValue.capitalized
  }
}

struct NativeManagedAccessLink: Identifiable, Equatable {
  let grantId: String
  let role: NativeLinkRole
  let url: String?
  let expiresAt: String?
  let createdAt: String?
  var status: NativeManagedAccessLinkStatus

  var id: String { grantId }

  init(link: NativeHostedShareLink) {
    grantId = link.grantId
    role = link.role
    url = link.url.absoluteString
    expiresAt = link.expiresAt
    createdAt = link.createdAt
    status = .active
  }

  init(grant: NativeHostedAccessGrantSummary, existing: NativeManagedAccessLink? = nil) {
    grantId = grant.grantId
    role = grant.role
    url = existing?.url
    expiresAt = grant.expiresAt
    createdAt = grant.createdAt
    status = Self.status(expiresAt: grant.expiresAt, revokedAt: grant.revokedAt)
  }

  private static func status(expiresAt: String?, revokedAt: String?) -> NativeManagedAccessLinkStatus {
    if revokedAt != nil { return .revoked }
    guard let expiresAt, let expiry = iso8601Date(from: expiresAt) else { return .active }
    return expiry <= Date() ? .expired : .active
  }

  private static func iso8601Date(from value: String) -> Date? {
    let standardFormatter = ISO8601DateFormatter()
    if let date = standardFormatter.date(from: value) {
      return date
    }
    let fractionalFormatter = ISO8601DateFormatter()
    fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractionalFormatter.date(from: value)
  }
}

struct NativeCollaboratorPresence: Identifiable, Equatable {
  let clientId: Int
  let name: String
  let color: String
  let colorLight: String
  let kind: String
  let clientKind: String?

  var id: Int { clientId }

  var roleLabel: String { "Edit" }

  var clientTypeLabel: String {
    switch clientKind {
    case "app":
      return "App"
    case "browser", "guest":
      return "Browser"
    case "agent":
      return "Agent"
    case "daemon":
      return "Daemon"
    case "api":
      return "API"
    default:
      return kind == "agent" ? "Agent" : "Collaborator"
    }
  }

  static func fromBridgePayload(_ payload: [String: Any]) -> NativeCollaboratorPresence? {
    let rawClientId = payload["clientId"]
    let clientId: Int?
    if let intValue = rawClientId as? Int {
      clientId = intValue
    } else if let numberValue = rawClientId as? NSNumber {
      clientId = numberValue.intValue
    } else {
      clientId = nil
    }
    guard let clientId else { return nil }
    let name = (payload["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let color = payload["color"] as? String
    let colorLight = payload["colorLight"] as? String
    let kind = payload["kind"] as? String
    return NativeCollaboratorPresence(
      clientId: clientId,
      name: name?.isEmpty == false ? name! : "Guest",
      color: color?.isEmpty == false ? color! : "#2563eb",
      colorLight: colorLight?.isEmpty == false ? colorLight! : "#dbeafe",
      kind: kind?.isEmpty == false ? kind! : "human",
      clientKind: payload["clientKind"] as? String
    )
  }
}

@MainActor
final class MarkLabAppModel: ObservableObject {
  @Published var statusText = "Open a Markdown file to start local editing or sharing."
  @Published var latestLink: String?
  @Published var latestGrantId: String?
  @Published var managedAccessLinks: [NativeManagedAccessLink] = []
  @Published var activeCollaborators: [NativeCollaboratorPresence] = []
  @Published var embeddedCollabURL: URL?
  @Published var text = ""
  @Published var filePath: String?
  @Published var conflict: MarkLabConflict?
  @Published var pendingDiskIngestion: PendingDiskIngestion?
  @Published var localDaemonContext: NativeAppContext?
  @Published var resolvedConflictMarkdown = ""
  @Published var resolvedConflictConfirmation = ""
  @Published var localAutosaveEnabled: Bool

  private var document: LocalMarkdownDocument?
  private let hostedShareController: NativeHostedShareController?
  private let baselineStore: NativeProjectionBaselineStore
  private let conflictStore: NativeConflictStore
  private let sharedDocumentBindingStore: NativeSharedDocumentBindingStore
  let nativeBearerToken: String?
  private let beforeDiskIngestionReplace: (() -> Void)?
  private let settingsDefaults: UserDefaults
  private var nativeShareController: NativeShareController?
  private var lastProjectedMarkdown: String?
  private var pendingSharedMarkdown: String?
  private var projectionTask: Task<Void, Never>?
  private var localAutosaveTask: Task<Void, Never>?
  private var diskIngestionRevision = 0
  private var fileWatcher: DispatchSourceFileSystemObject?
  let opensSelectedFilesInNewDocumentWindow: Bool
  private static let localAutosaveDelayNanoseconds: UInt64 = 2_000_000_000
  private static let localAutosaveEnabledDefaultsKey = "MarkLabLocalAutosaveEnabled"

  init(
    hostedShareController: NativeHostedShareController? = MarkLabAppModel.makeHostedShareControllerFromEnvironment(),
    baselineStore: NativeProjectionBaselineStore = FileNativeProjectionBaselineStore.defaultStore(),
    conflictStore: NativeConflictStore = NativeConflictStore.defaultStore(),
    sharedDocumentBindingStore: NativeSharedDocumentBindingStore = FileNativeSharedDocumentBindingStore.defaultStore(),
    nativeBearerToken: String? = ProcessInfo.processInfo.environment["MARKLAB_USER_TOKEN"],
    beforeDiskIngestionReplace: (() -> Void)? = nil,
    opensSelectedFilesInNewDocumentWindow: Bool = false,
    localAutosaveEnabled: Bool? = nil,
    settingsDefaults: UserDefaults = .standard
  ) {
    self.hostedShareController = hostedShareController
    self.baselineStore = baselineStore
    self.conflictStore = conflictStore
    self.sharedDocumentBindingStore = sharedDocumentBindingStore
    self.nativeBearerToken = nativeBearerToken
    self.beforeDiskIngestionReplace = beforeDiskIngestionReplace
    self.settingsDefaults = settingsDefaults
    self.opensSelectedFilesInNewDocumentWindow = opensSelectedFilesInNewDocumentWindow
    self.localAutosaveEnabled = localAutosaveEnabled ?? Self.defaultLocalAutosaveEnabled(defaults: settingsDefaults)
    if hostedShareController == nil {
      statusText = "Open a Markdown file. Sign in/workspace environment is required before sharing."
    }
  }

  deinit {
    localAutosaveTask?.cancel()
    projectionTask?.cancel()
    fileWatcher?.cancel()
  }

  static func defaultLocalAutosaveEnabled(defaults: UserDefaults = .standard) -> Bool {
    defaults.bool(forKey: localAutosaveEnabledDefaultsKey)
  }

  var actionsEnabled: Bool {
    hostedShareController != nil && document != nil && conflict == nil
  }

  var canStartSharing: Bool {
    actionsEnabled && embeddedCollabURL == nil
  }

  var canCreateSharingLink: Bool {
    actionsEnabled && embeddedCollabURL != nil
  }

  var canStopSharing: Bool {
    embeddedCollabURL != nil && conflict == nil
  }

  var hasSharedDocument: Bool {
    embeddedCollabURL != nil
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

  static func markEditNativeShellURL(_ url: URL?) -> URL? {
    guard let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    guard components.path == "/collab" else { return url }
    var queryItems = components.queryItems ?? []
    if let nativeShellIndex = queryItems.firstIndex(where: { $0.name == "nativeShell" }) {
      queryItems[nativeShellIndex] = URLQueryItem(name: "nativeShell", value: "markedit")
    } else {
      queryItems.append(URLQueryItem(name: "nativeShell", value: "markedit"))
    }
    components.queryItems = queryItems
    components.percentEncodedFragment = nil
    return components.url ?? url
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
      try flushLocalAutosave()
      let sharedBinding = try? sharedDocumentBindingStore.loadBinding(fileURL: url)
      let opened = try LocalMarkdownDocument.open(fileURL: url, shared: sharedBinding != nil)
      document = opened
      text = opened.text
      filePath = url.path
      if let sharedBinding {
        hostedShareController?.restoreSharedDocument(from: sharedBinding, suggestedFilename: url.lastPathComponent)
      }
      latestLink = nil
      latestGrantId = nil
      managedAccessLinks = []
      activeCollaborators = []
      embeddedCollabURL = nil
      pendingDiskIngestion = nil
      localDaemonContext = nil
      nativeShareController = nil
      pendingSharedMarkdown = nil
      lastProjectedMarkdown = (try? baselineStore.loadBaseline(fileURL: url))?.lastProjectedMarkdown ?? opened.markdownForSave()
      if let persistedConflict = try? conflictStore.load(fileURL: url) {
        let bindingURL = sharedBinding.flatMap { Self.markEditNativeShellURL($0.appEditorURL) }
        let normalizedConflict = persistedConflict.withSharedEditorURL(
          Self.markEditNativeShellURL(persistedConflict.sharedEditorURL) ?? bindingURL
        )
        embeddedCollabURL = normalizedConflict.sharedEditorURL
        setConflict(normalizedConflict, status: "Conflict: review required before syncing resumes.")
      } else if let sharedBinding {
        clearConflictState()
        embeddedCollabURL = Self.markEditNativeShellURL(sharedBinding.appEditorURL)
        statusText = "Joined shared document \(sharedBinding.docId)."
        Task {
          await refreshManagedAccessLinksFromServer()
        }
      } else {
        clearConflictState()
        statusText = "Editing \(url.lastPathComponent)."
      }
      startFileWatcher(for: url)
    } catch {
      statusText = "Unable to open Markdown file."
    }
  }

  func openSharedLink() {
    let alert = NSAlert()
    alert.messageText = "Open Shared Link"
    alert.informativeText = "Paste a MarkLab edit link, then choose where this shared document should live as a local Markdown file."
    alert.addButton(withTitle: "Continue")
    alert.addButton(withTitle: "Cancel")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 460, height: 24))
    field.stringValue = NSPasteboard.general.string(forType: .string) ?? ""
    field.placeholderString = "https://.../collab?docId=...&branchId=...&token=...&mode=edit"
    alert.accessoryView = field
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let linkValue = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      let link = try NativeSharedDocumentLink.parse(linkValue)
      try promptForSharedDocumentTarget(link: link)
    } catch {
      statusText = Self.sharedDocumentJoinStatus(for: error)
    }
  }

  func openSharedLink(from url: URL) {
    do {
      let link = try NativeSharedDocumentLink.parse(url)
      try promptForSharedDocumentTarget(link: link)
    } catch {
      statusText = Self.sharedDocumentJoinStatus(for: error)
    }
  }

  private func promptForSharedDocumentTarget(link: NativeSharedDocumentLink) throws {
    guard link.mode == .edit else {
      throw NativeSharedDocumentLinkError.localJoinRequiresEditLink
    }
    let panel = NSOpenPanel()
    panel.title = "Choose Folder For Shared Markdown File"
    panel.message = "MarkLab will create or reuse \(link.localFilename) in the selected folder."
    panel.prompt = "Join"
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let folderURL = panel.url else { return }
    let targetURL = folderURL.appending(path: link.localFilename, directoryHint: .notDirectory)
    try joinSharedDocument(link: link, localFileURL: targetURL)
  }

  func joinSharedDocument(linkString: String, localFileURL: URL) throws {
    try joinSharedDocument(link: NativeSharedDocumentLink.parse(linkString), localFileURL: localFileURL)
  }

  func joinSharedDocument(link: NativeSharedDocumentLink, localFileURL: URL) throws {
    guard link.mode == .edit else {
      throw NativeSharedDocumentLinkError.localJoinRequiresEditLink
    }
    guard link.token?.isEmpty == false else {
      throw NativeSharedDocumentLinkError.missingAccessToken
    }
    let existingBinding = try? sharedDocumentBindingStore.loadBinding(fileURL: localFileURL)
    if existingBinding?.matches(link) != true && Self.localFileHasUserContent(localFileURL) {
      throw NativeSharedDocumentLinkError.localFileNotEmpty
    }
    try FileManager.default.createDirectory(at: localFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: localFileURL.path) {
      try Data().write(to: localFileURL, options: [.atomic])
    }
    let localDocId = NativeLocalDocumentIdentity.localDocId(fileURL: localFileURL)
    let appEditorURL = Self.markEditNativeShellURL(link.appEditorURL(localDocId: localDocId)) ?? link.appEditorURL(localDocId: localDocId)
    let baselineMarkdown = (try? String(contentsOf: localFileURL, encoding: .utf8)) ?? ""
    try sharedDocumentBindingStore.saveBinding(
      NativeSharedDocumentBinding(
        fileURL: localFileURL,
        link: link,
        appEditorURL: appEditorURL,
        baselineMarkdown: baselineMarkdown
      ),
      fileURL: localFileURL
    )
    try baselineStore.saveBaseline(
      NativeProjectionBaselineRecord(
        markdown: LocalMarkdownDocument.normalizeForSharedSave(baselineMarkdown),
        providerStateFingerprint: NativeProjectionBaselineRecord.providerYTextFingerprint(
          LocalMarkdownDocument.normalizeForSharedSave(baselineMarkdown)
        )
      ),
      fileURL: localFileURL
    )
    loadFile(localFileURL)
    embeddedCollabURL = appEditorURL
    latestLink = link.originalURL.absoluteString
    latestGrantId = nil
    managedAccessLinks = []
    activeCollaborators = []
    statusText = "Joined shared document \(link.docId). Waiting for shared content."
  }

  static func sharedDocumentJoinStatus(for error: Error) -> String {
    switch error {
    case NativeSharedDocumentLinkError.localJoinRequiresEditLink:
      return "Open an edit link in MarkLab.app. View links stay browser-only."
    case NativeSharedDocumentLinkError.localFileNotEmpty:
      return "Choose an empty file or reopen the existing bound shared file."
    case NativeSharedDocumentLinkError.unsupportedURL:
      return "Open a MarkLab /collab edit link."
    case NativeSharedDocumentLinkError.missingDocId:
      return "Shared link is missing docId."
    case NativeSharedDocumentLinkError.missingBranchId:
      return "Shared link is missing branchId."
    case NativeSharedDocumentLinkError.missingAccessToken:
      return "Open a tokenized edit link in MarkLab.app."
    case NativeSharedDocumentLinkError.invalidMode:
      return "Shared link has an invalid mode."
    default:
      return "Unable to open shared link."
    }
  }

  private static func localFileHasUserContent(_ url: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: url.path) else { return false }
    guard let data = try? Data(contentsOf: url) else { return false }
    return !data.isEmpty
  }

  func saveFile() throws {
    if conflict != nil {
      statusText = "Resolve the conflict before saving."
      return
    }
    localAutosaveTask?.cancel()
    localAutosaveTask = nil
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

  func receiveLocalEditorMarkdown(_ markdown: String) {
    guard text != markdown else { return }
    text = markdown
    scheduleLocalAutosave()
  }

  @discardableResult
  func flushLocalAutosave() throws -> Bool {
    localAutosaveTask?.cancel()
    localAutosaveTask = nil
    return try autosaveLocalDocumentIfNeeded()
  }

  func setLocalAutosaveEnabled(_ enabled: Bool) {
    guard localAutosaveEnabled != enabled else { return }
    localAutosaveEnabled = enabled
    settingsDefaults.set(enabled, forKey: Self.localAutosaveEnabledDefaultsKey)
    if enabled {
      do {
        let saved = try flushLocalAutosave()
        if !saved {
          statusText = "Local autosave enabled."
        }
      } catch {
        statusText = "Unable to autosave Markdown file."
      }
    } else {
      localAutosaveTask?.cancel()
      localAutosaveTask = nil
      statusText = "Local autosave disabled."
    }
  }

  private func scheduleLocalAutosave() {
    guard localAutosaveEnabled, embeddedCollabURL == nil, conflict == nil, document != nil else { return }
    let delay = Self.localAutosaveDelayNanoseconds
    localAutosaveTask?.cancel()
    localAutosaveTask = Task { [weak self] in
      do {
        try await Task.sleep(nanoseconds: delay)
      } catch {
        return
      }
      guard !Task.isCancelled else { return }
      await MainActor.run {
        self?.flushLocalAutosaveFromTimer()
      }
    }
  }

  private func flushLocalAutosaveFromTimer() {
    do {
      try flushLocalAutosave()
    } catch {
      statusText = "Unable to autosave Markdown file."
    }
  }

  private func autosaveLocalDocumentIfNeeded() throws -> Bool {
    guard localAutosaveEnabled, embeddedCollabURL == nil, conflict == nil, var currentDocument = document else { return false }
    guard currentDocument.text != text else { return false }
    currentDocument.replaceText(text)
    try currentDocument.save()
    document = currentDocument
    try updateProjectionBaseline(currentDocument.markdownForSave(), fileURL: currentDocument.fileURL)
    statusText = "Autosaved \(currentDocument.fileURL.lastPathComponent)."
    return true
  }

  func startSharing() {
    Task {
      await startSharingAndConnect()
    }
  }

  func startSharingAndConnect() async {
    guard conflict == nil else {
      statusText = "Resolve the conflict before sharing."
      return
    }
    guard let hostedShareController, let fileURL = document?.fileURL else { return }
    do {
      try saveFile()
      let shared = try await hostedShareController.startSharing(fileURL: fileURL)
      latestLink = nil
      latestGrantId = nil
      managedAccessLinks = []
      activeCollaborators = []
      let appEditorURL = try hostedShareController.appEditorURL()
      let sharedMarkdown = try LocalMarkdownDocument.open(fileURL: fileURL, shared: true).markdownForSave()
      try sharedDocumentBindingStore.saveBinding(
        NativeSharedDocumentBinding(
          fileURL: fileURL,
          document: shared,
          appEditorURL: appEditorURL,
          baselineMarkdown: sharedMarkdown
        ),
        fileURL: fileURL
      )
      try updateProjectionBaseline(sharedMarkdown, fileURL: fileURL)
      embeddedCollabURL = appEditorURL
      ensureCLILocalDaemonBoundary(fileURL: fileURL)
      statusText = "Shared \(fileURL.lastPathComponent) as \(shared.docId). App editor connected as workspace user."
      await refreshManagedAccessLinksFromServer()
    } catch {
      statusText = "Unable to start sharing."
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
        upsertManagedAccessLink(NativeManagedAccessLink(link: link))
        copyLinkToPasteboard(link.url.absoluteString)
        statusText = Self.linkCopiedStatusText(role: role)
      } catch {
        statusText = "Unable to create \(role.rawValue) link."
      }
    }
  }

  func stopSharing() {
    Task {
      await stopSharingAndReturnToLocalEditing()
    }
  }

  func stopSharingAndReturnToLocalEditing() async {
    guard hasSharedDocument else { return }
    guard conflict == nil else {
      statusText = "Resolve the conflict before stopping sharing."
      return
    }

    let fileURL = document?.fileURL
    do {
      try flushPendingSharedProjection()
      guard conflict == nil else {
        statusText = "Resolve the conflict before stopping sharing."
        return
      }
    } catch {
      statusText = "Unable to save shared changes before stopping sharing."
      return
    }

    let activeLinks = await accessLinksForStopSharing()
    var revokeFailures = 0
    if let hostedShareController {
      for link in activeLinks where link.status == .active {
        do {
          try await hostedShareController.revokeLink(grantId: link.grantId)
        } catch {
          revokeFailures += 1
        }
      }
    }

    projectionTask?.cancel()
    projectionTask = nil
    pendingSharedMarkdown = nil
    pendingDiskIngestion = nil
    embeddedCollabURL = nil
    latestLink = nil
    latestGrantId = nil
    managedAccessLinks = []
    activeCollaborators = []
    localDaemonContext = nil
    nativeShareController = nil
    lastProjectedMarkdown = nil

    if let fileURL {
      try? sharedDocumentBindingStore.clearBinding(fileURL: fileURL)
      try? baselineStore.clearBaseline(fileURL: fileURL)
      if let localDocument = try? LocalMarkdownDocument.open(fileURL: fileURL, shared: false) {
        document = localDocument
        text = localDocument.text
        filePath = fileURL.path
      }
      let filename = fileURL.lastPathComponent
      statusText = revokeFailures == 0
        ? "Stopped sharing \(filename)."
        : "Stopped sharing \(filename), but some links could not be revoked."
    } else {
      statusText = revokeFailures == 0
        ? "Stopped sharing."
        : "Stopped sharing, but some links could not be revoked."
    }
  }

  func copyLatestLink() {
    guard let latestLink else { return }
    copyLinkToPasteboard(latestLink)
    statusText = "Link copied to clipboard."
  }

  func copyAccessLink(_ link: NativeManagedAccessLink) {
    guard let url = link.url else {
      statusText = "Link URL is unavailable after relaunch. Revoke still works."
      return
    }
    copyLinkToPasteboard(url)
    statusText = "Link copied to clipboard."
  }

  static func linkCopiedStatusText(role: NativeLinkRole) -> String {
    "\(role.rawValue.capitalized) link copied to clipboard."
  }

  private func copyLinkToPasteboard(_ link: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(link, forType: .string)
  }

  func revokeLatestLink() {
    guard let hostedShareController, let latestGrantId else { return }
    Task {
      do {
        try await hostedShareController.revokeLink(grantId: latestGrantId)
        self.removeManagedAccessLink(grantId: latestGrantId)
        self.latestGrantId = nil
        self.latestLink = nil
        statusText = "Latest link revoked."
      } catch {
        statusText = "Unable to revoke latest link."
      }
    }
  }

  func revokeAccessLink(_ link: NativeManagedAccessLink) {
    guard let hostedShareController else { return }
    Task {
      do {
        try await hostedShareController.revokeLink(grantId: link.grantId)
        removeManagedAccessLink(grantId: link.grantId)
        if latestGrantId == link.grantId {
          latestGrantId = nil
          latestLink = nil
        }
        statusText = "\(link.role.rawValue.capitalized) link revoked."
      } catch {
        statusText = "Unable to revoke \(link.role.rawValue) link."
      }
    }
  }

  private func upsertManagedAccessLink(_ link: NativeManagedAccessLink) {
    managedAccessLinks.removeAll { $0.grantId == link.grantId }
    managedAccessLinks.insert(link, at: 0)
  }

  private func removeManagedAccessLink(grantId: String) {
    managedAccessLinks.removeAll { $0.grantId == grantId }
  }

  func refreshManagedAccessLinksFromServer() async {
    let expectedFileURL = document?.fileURL
    guard let hostedShareController, embeddedCollabURL != nil else { return }
    do {
      let grants = try await hostedShareController.listLinks()
      guard embeddedCollabURL != nil, document?.fileURL == expectedFileURL else { return }
      let existingById = Dictionary(uniqueKeysWithValues: managedAccessLinks.map { ($0.grantId, $0) })
      managedAccessLinks = grants
        .map { NativeManagedAccessLink(grant: $0, existing: existingById[$0.grantId]) }
        .filter { $0.status != .revoked }
      if let latestGrantId, !managedAccessLinks.contains(where: { $0.grantId == latestGrantId }) {
        self.latestGrantId = nil
        latestLink = nil
      }
    } catch {
      // Existing in-memory links remain usable even if the historical grant list is temporarily unavailable.
    }
  }

  private func accessLinksForStopSharing() async -> [NativeManagedAccessLink] {
    guard let hostedShareController else {
      return managedAccessLinks.filter { $0.status == .active }
    }
    do {
      let grants = try await hostedShareController.listLinks()
      let existingById = Dictionary(uniqueKeysWithValues: managedAccessLinks.map { ($0.grantId, $0) })
      let serverLinks = grants
        .map { NativeManagedAccessLink(grant: $0, existing: existingById[$0.grantId]) }
        .filter { $0.status != .revoked }
      managedAccessLinks = serverLinks
      return serverLinks
    } catch {
      return managedAccessLinks.filter { $0.status == .active }
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

  func receiveActiveCollaborators(_ collaborators: [NativeCollaboratorPresence]) {
    activeCollaborators = collaborators.sorted { left, right in
      if left.name == right.name { return left.clientId < right.clientId }
      return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }
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
      embeddedCollabURL = Self.markEditNativeShellURL(url)
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
    guard Self.localDaemonBoundaryEnabled(environment: environment) else { return }
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

  static func localDaemonBoundaryEnabled(environment: [String: String]) -> Bool {
    if environment["MARKLAB_APP_SKIP_LOCAL_DAEMON"] == "1" { return false }
    return environment["MARKLAB_APP_ENABLE_LOCAL_DAEMON_BOUNDARY"] == "1"
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
    guard let url = Self.markEditNativeShellURL(url),
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else {
      return nil
    }
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
  @StateObject private var model: MarkLabAppModel
  private let launchFileURL: URL?
  @State private var didLoadLaunchFile = false

  init(model: MarkLabAppModel, launchFileURL: URL? = nil) {
    _model = StateObject(wrappedValue: model)
    self.launchFileURL = launchFileURL
  }

  var body: some View {
    MarkEditDocumentShellView(model: model)
      .onOpenURL { url in
        model.openSharedLink(from: url)
      }
      .onAppear {
        guard !didLoadLaunchFile, let launchFileURL else { return }
        didLoadLaunchFile = true
        guard !MarkLabLaunchFileCoordinator.isClaimed(launchFileURL) else { return }
        model.loadFile(launchFileURL)
        if model.filePath == launchFileURL.path {
          _ = MarkLabLaunchFileCoordinator.claim(launchFileURL)
        }
      }
  }
}

struct HostedCollabWebView: NSViewRepresentable {
  let url: URL
  let diskIngestion: PendingDiskIngestion?
  let nativeBearerToken: String?
  let command: MarkEditLocalEditorCommand?
  let isEditable: Bool
  let onMarkdownSnapshot: (String) -> Void
  let onSelectionStatus: (String) -> Void
  let onCollaboratorsChange: ([NativeCollaboratorPresence]) -> Void
  let onDiskIngestionResult: (DiskIngestionBridgeResult) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(
      expectedURL: url,
      onMarkdownSnapshot: onMarkdownSnapshot,
      onSelectionStatus: onSelectionStatus,
      onCollaboratorsChange: onCollaboratorsChange,
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
    context.coordinator.applyEditorEditability(isEditable, in: webView)
    if let command {
      context.coordinator.applyEditorCommand(command, in: webView)
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

  static func editorCommandJavaScriptForTesting(_ command: MarkEditLocalEditorCommand) -> String {
    editorCommandJavaScript(command)
  }

  static func nativeEditableJavaScriptForTesting(_ isEditable: Bool) -> String {
    nativeEditableJavaScript(isEditable)
  }

  fileprivate static func editorCommandJavaScript(_ command: MarkEditLocalEditorCommand) -> String {
    "typeof window.__marklabRunEditorCommand === 'function' && window.__marklabRunEditorCommand(\(command.action.javascriptPayload)) === true;"
  }

  fileprivate static func nativeEditableJavaScript(_ isEditable: Bool) -> String {
    "typeof window.__marklabSetNativeEditable === 'function' && window.__marklabSetNativeEditable(\(isEditable ? "true" : "false")) === true;"
  }

  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let onMarkdownSnapshot: (String) -> Void
    private let onSelectionStatus: (String) -> Void
    private let onCollaboratorsChange: ([NativeCollaboratorPresence]) -> Void
    private let onDiskIngestionResult: (DiskIngestionBridgeResult) -> Void
    var expectedURL: URL
    var expectedOrigin: NativeHostedWebViewOrigin
    var lastAppliedDiskIngestionRevision = 0
    private var retryCounts: [Int: Int] = [:]
    private var lastAppliedEditorCommandSequence = 0
    private var editorCommandRetryCounts: [Int: Int] = [:]
    private var inFlightEditorCommandSequence: Int?
    private var desiredEditorEditable = true
    private var lastAppliedEditorEditable: Bool?
    private var inFlightEditorEditable: Bool?
    private var editorEditableRetryCount = 0

    init(
      expectedURL: URL,
      onMarkdownSnapshot: @escaping (String) -> Void,
      onSelectionStatus: @escaping (String) -> Void,
      onCollaboratorsChange: @escaping ([NativeCollaboratorPresence]) -> Void,
      onDiskIngestionResult: @escaping (DiskIngestionBridgeResult) -> Void
    ) {
      self.expectedURL = expectedURL
      self.expectedOrigin = NativeHostedWebViewOrigin(url: expectedURL)
      self.onMarkdownSnapshot = onMarkdownSnapshot
      self.onSelectionStatus = onSelectionStatus
      self.onCollaboratorsChange = onCollaboratorsChange
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
      guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
      if type == "markdown-snapshot", let markdown = body["markdown"] as? String {
        onMarkdownSnapshot(markdown)
        return
      }
      if type == "selection-change", let status = body["status"] as? String {
        onSelectionStatus(status)
        return
      }
      if type == "collaborators-change", let rawCollaborators = body["collaborators"] as? [[String: Any]] {
        onCollaboratorsChange(rawCollaborators.compactMap(NativeCollaboratorPresence.fromBridgePayload))
      }
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

    func applyEditorCommand(_ command: MarkEditLocalEditorCommand, in webView: WKWebView) {
      guard
        command.sequence > lastAppliedEditorCommandSequence,
        inFlightEditorCommandSequence != command.sequence
      else {
        return
      }
      inFlightEditorCommandSequence = command.sequence
      webView.evaluateJavaScript(
        HostedCollabWebView.editorCommandJavaScript(command)
      ) { [weak self, weak webView] value, error in
        guard let self else { return }
        self.inFlightEditorCommandSequence = nil
        if error == nil, value as? Bool == true {
          self.lastAppliedEditorCommandSequence = command.sequence
          self.editorCommandRetryCounts.removeValue(forKey: command.sequence)
          return
        }
        self.retryEditorCommand(command, in: webView)
      }
    }

    func applyEditorEditability(_ isEditable: Bool, in webView: WKWebView) {
      desiredEditorEditable = isEditable
      guard lastAppliedEditorEditable != isEditable, inFlightEditorEditable != isEditable else { return }
      inFlightEditorEditable = isEditable
      webView.evaluateJavaScript(
        HostedCollabWebView.nativeEditableJavaScript(isEditable)
      ) { [weak self, weak webView] value, error in
        guard let self else { return }
        self.inFlightEditorEditable = nil
        if error == nil, value as? Bool == true {
          self.lastAppliedEditorEditable = isEditable
          self.editorEditableRetryCount = 0
          if self.desiredEditorEditable != isEditable, let webView {
            self.applyEditorEditability(self.desiredEditorEditable, in: webView)
          }
          return
        }
        if self.desiredEditorEditable == isEditable {
          self.retryEditorEditability(isEditable, in: webView)
        } else if let webView {
          self.applyEditorEditability(self.desiredEditorEditable, in: webView)
        }
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

    private func retryEditorCommand(_ command: MarkEditLocalEditorCommand, in webView: WKWebView?) {
      let attempts = (editorCommandRetryCounts[command.sequence] ?? 0) + 1
      editorCommandRetryCounts[command.sequence] = attempts
      guard attempts < 20, let webView else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak webView] in
        guard let self, let webView else { return }
        self.applyEditorCommand(command, in: webView)
      }
    }

    private func retryEditorEditability(_ isEditable: Bool, in webView: WKWebView?) {
      editorEditableRetryCount += 1
      guard editorEditableRetryCount < 20, let webView else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak webView] in
        guard let self, let webView else { return }
        guard self.desiredEditorEditable == isEditable else {
          self.applyEditorEditability(self.desiredEditorEditable, in: webView)
          return
        }
        self.applyEditorEditability(isEditable, in: webView)
      }
    }
  }
}
