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
        model: MarkLabAppModel(
          accountStore: NativeAccountStore.defaultStore(),
          opensSelectedFilesInNewDocumentWindow: true
        ),
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

    Settings {
      MarkLabSettingsView()
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

@MainActor
final class MarkLabAppDelegate: NSObject, NSApplicationDelegate {
  private var menuBarController: MarkLabMenuBarController?
  private var cliRequestPump: NativeCLIShareRequestPump?
  private var cliRequestTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    menuBarController = MarkLabMenuBarController()
    MarkLabSharedSessionRestorer.restoreActiveSessions()
    let cliRequestId = MarkLabCLIRequestLaunch.requestId(from: CommandLine.arguments)
    let cliStore = FileNativeCLIShareRequestStore(appSupportDirectory: NativeAppSupportDirectory.url())
    let cliProcessor = NativeCLIShareRequestProcessor(
      store: cliStore,
      shareService: NativeCLIShareAppService(
        backgroundHost: .shared,
        makeHostedShareController: MarkLabAppModel.makeHostedShareController(from:)
      ) { hostedShareController, nativeBearerToken in
        MarkLabAppModel(
          hostedShareController: hostedShareController,
          nativeBearerToken: nativeBearerToken,
          accountStore: NativeAccountStore.defaultStore(),
          opensSelectedFilesInNewDocumentWindow: false
        )
      }
    )
    cliRequestPump = NativeCLIShareRequestPump(store: cliStore, processor: cliProcessor)
    startNativeCLIRequestPolling()
    NSApp.setActivationPolicy(.regular)
    if cliRequestId == nil {
      NSApp.activate(ignoringOtherApps: true)
    }

    if cliRequestId != nil {
      Task { @MainActor in
        try? await cliRequestPump?.processPendingRequests()
      }
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      guard let launchFileURL = MarkLabLaunchFile.url(from: CommandLine.arguments) else { return }
      guard !MarkLabLaunchFileCoordinator.isClaimed(launchFileURL) else { return }
      if case .opened = MarkEditDocumentWindowCoordinator.shared.openDocumentWindow(fileURL: launchFileURL) {
        _ = MarkLabLaunchFileCoordinator.claim(launchFileURL)
      }
    }
  }

  @MainActor
  private func startNativeCLIRequestPolling() {
    cliRequestTimer?.invalidate()
    cliRequestTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in
      Task { @MainActor in
        do {
          try await self?.cliRequestPump?.processPendingRequests()
        } catch {
          // Keep polling; individual failures are written as CLI response files by the processor.
        }
      }
    }
    cliRequestTimer?.tolerance = 0.25
    Task { @MainActor in
      try? await cliRequestPump?.processPendingRequests()
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

enum MarkLabCLIRequestLaunch {
  static func requestId(from arguments: [String]) -> String? {
    guard let flagIndex = arguments.firstIndex(of: "--marklab-cli-request") else { return nil }
    let valueIndex = arguments.index(after: flagIndex)
    guard valueIndex < arguments.endIndex else { return nil }
    let value = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
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

enum NativeSignInPromptReason: Equatable {
  case startSharing
  case openSharedDocument
}

enum SharedProjectionResult: Equatable {
  case noPending
  case applied
  case conflictOpened

  var openedConflict: Bool {
    self == .conflictOpened
  }
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

private final class NotificationObserverToken: @unchecked Sendable {
  private let token: NSObjectProtocol

  init(_ token: NSObjectProtocol) {
    self.token = token
  }

  func invalidate() {
    NotificationCenter.default.removeObserver(token)
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
  @Published var resolvedConflictMarkdown = ""
  @Published var resolvedConflictConfirmation = ""
  @Published var localAutosaveEnabled: Bool
  @Published var versionHistory: [NativeDocumentVersionSummary] = []
  @Published var selectedVersionId: String?
  @Published var selectedVersion: NativeDocumentVersionSnapshot?
  @Published var isLoadingVersions = false
  @Published var restoreVersionConfirmation = ""
  @Published var deleteCloudCopyConfirmation = ""
  @Published var retainedCloudCopyAvailable = false
  @Published private(set) var activeAccount: NativeStoredAccount?

  private var document: LocalMarkdownDocument?
  private var hostedShareController: NativeHostedShareController?
  private let baselineStore: NativeProjectionBaselineStore
  private let conflictStore: NativeConflictStore
  private let sharedDocumentBindingStore: NativeSharedDocumentBindingStore
  private let sessionManager: NativeSharedDocumentSessionManager
  private(set) var nativeBearerToken: String?
  private let accountStore: NativeAccountStore?
  private let accountTransport: NativeHTTPTransport
  private let hostedDefaults: NativeHostedDefaults
  private let beforeDiskIngestionReplace: (() -> Void)?
  private let signInPrompt: @MainActor (URL, NativeSignInPromptReason) -> Void
  private let settingsDefaults: UserDefaults
  private var lastProjectedMarkdown: String?
  private var pendingSharedMarkdown: String?
  private var projectionTask: Task<Void, Never>?
  private var localAutosaveTask: Task<Void, Never>?
  private var localAutosaveDefaultsObserver: NotificationObserverToken?
  private var accountSignOutObserver: NotificationObserverToken?
  private var accountSignInObserver: NotificationObserverToken?
  private var diskIngestionRevision = 0
  private var versionHistoryRequestRevision = 0
  private var fileWatcher: DispatchSourceFileSystemObject?
  let opensSelectedFilesInNewDocumentWindow: Bool
  private static let localAutosaveDelayNanoseconds: UInt64 = 2_000_000_000

  init(
    hostedShareController: NativeHostedShareController? = MarkLabAppModel.makeHostedShareControllerFromEnvironment(),
    baselineStore: NativeProjectionBaselineStore = FileNativeProjectionBaselineStore.defaultStore(),
    conflictStore: NativeConflictStore = NativeConflictStore.defaultStore(),
    sharedDocumentBindingStore: NativeSharedDocumentBindingStore = FileNativeSharedDocumentBindingStore.defaultStore(),
    sessionManager: NativeSharedDocumentSessionManager = .shared,
    nativeBearerToken: String? = ProcessInfo.processInfo.environment["MARKLAB_USER_TOKEN"],
    accountStore: NativeAccountStore? = nil,
    accountTransport: NativeHTTPTransport = URLSessionNativeHTTPTransport(),
    hostedDefaults: NativeHostedDefaults = .fromEnvironment(),
    beforeDiskIngestionReplace: (() -> Void)? = nil,
    signInPrompt: @escaping @MainActor (URL, NativeSignInPromptReason) -> Void = MarkLabAppModel.defaultSignInPrompt,
    opensSelectedFilesInNewDocumentWindow: Bool = false,
    localAutosaveEnabled: Bool? = nil,
    settingsDefaults: UserDefaults = .standard
  ) {
    let storedAccount = try? accountStore?.load()
    self.hostedShareController = hostedShareController ?? storedAccount.flatMap {
      Self.makeHostedShareController(from: $0, transport: accountTransport)
    }
    self.baselineStore = baselineStore
    self.conflictStore = conflictStore
    self.sharedDocumentBindingStore = sharedDocumentBindingStore
    self.sessionManager = sessionManager
    self.nativeBearerToken = nativeBearerToken ?? storedAccount?.token
    self.accountStore = accountStore
    self.accountTransport = accountTransport
    self.hostedDefaults = hostedDefaults
    self.activeAccount = storedAccount
    self.beforeDiskIngestionReplace = beforeDiskIngestionReplace
    self.signInPrompt = signInPrompt
    self.settingsDefaults = settingsDefaults
    self.opensSelectedFilesInNewDocumentWindow = opensSelectedFilesInNewDocumentWindow
    self.localAutosaveEnabled = localAutosaveEnabled ?? Self.defaultLocalAutosaveEnabled(defaults: settingsDefaults)
    if localAutosaveEnabled == nil {
      let observer = NotificationCenter.default.addObserver(
        forName: UserDefaults.didChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor in
          self?.reloadLocalAutosaveSettingFromDefaults()
        }
      }
      localAutosaveDefaultsObserver = NotificationObserverToken(observer)
    }
    let accountObserver = NotificationCenter.default.addObserver(
      forName: .markLabAccountDidSignOut,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      let token = notification.userInfo?[NativeAccountSignOutNotification.tokenKey] as? String
      Task { @MainActor in
        guard let self else { return }
        guard token == nil || token == self.activeAccount?.token else { return }
        self.applySignedOutState(status: "Signed out. Sign in before sharing.", clearStore: false, broadcast: false)
      }
    }
    accountSignOutObserver = NotificationObserverToken(accountObserver)
    let signInObserver = NotificationCenter.default.addObserver(
      forName: .markLabAccountDidSignIn,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      let token = notification.userInfo?[NativeAccountSignInNotification.tokenKey] as? String
      Task { @MainActor in
        guard let self, let account = try? self.accountStore?.load() else { return }
        guard token == nil || token == account.token else { return }
        self.applySignedInState(account, status: "Signed in as \(account.displayName). Workspace: \(account.workspaceName).")
      }
    }
    accountSignInObserver = NotificationObserverToken(signInObserver)
    if self.hostedShareController == nil {
      statusText = "Open a Markdown file. Sign in before sharing."
    } else if let storedAccount {
      statusText = "Signed in as \(storedAccount.displayName). Workspace: \(storedAccount.workspaceName)."
    }
  }

  deinit {
    localAutosaveDefaultsObserver?.invalidate()
    accountSignOutObserver?.invalidate()
    accountSignInObserver?.invalidate()
    localAutosaveTask?.cancel()
    projectionTask?.cancel()
    fileWatcher?.cancel()
  }

  static func defaultLocalAutosaveEnabled(defaults: UserDefaults = .standard) -> Bool {
    defaults.bool(forKey: MarkLabAppSettings.localAutosaveEnabledDefaultsKey)
  }

  var actionsEnabled: Bool {
    hostedShareController != nil && document != nil && conflict == nil
  }

  var documentReadyForSharing: Bool {
    document != nil && conflict == nil
  }

  var isSignedIn: Bool {
    nativeBearerToken?.isEmpty == false
  }

  var signInURL: URL {
    var components = URLComponents(url: hostedDefaults.webBaseURL.appending(path: "signin"), resolvingAgainstBaseURL: false)!
    let appState = NativeAuthPendingState.generate()
    try? accountStore?.savePendingAuthState(appState)
    components.queryItems = [
      URLQueryItem(name: "native", value: "1"),
      URLQueryItem(name: "appState", value: appState),
    ]
    return components.url!
  }

  var canStartSharing: Bool {
    documentReadyForSharing && embeddedCollabURL == nil
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

  var hasCloudCopyReference: Bool {
    hasSharedDocument || retainedCloudCopyAvailable
  }

  var fileURLForBackgroundRetention: URL? {
    document?.fileURL
  }

  @discardableResult
  func retainSharedDocumentForBackgroundIfNeeded(
    backgroundHost: MarkLabBackgroundSharedDocumentHost = .shared
  ) -> Bool {
    guard hasSharedDocument, let fileURL = fileURLForBackgroundRetention else { return false }
    backgroundHost.retain(self, fileURL: fileURL)
    sessionManager.detachWindow(fileURL: fileURL)
    return true
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

  var canApplySelectedVersionRestore: Bool {
    selectedVersion?.versionId == selectedVersionId
      && restoreVersionConfirmation == "RESTORE"
      && hasCloudCopyReference
      && conflict == nil
  }

  var canDeleteCloudCopy: Bool {
    hasCloudCopyReference && conflict == nil && deleteCloudCopyConfirmation == "DELETE CLOUD COPY"
  }

  static func markEditNativeShellURL(_ url: URL?, displayName: String? = nil) -> URL? {
    guard let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    guard components.path == "/collab" else { return url }
    var queryItems = components.queryItems ?? []
    if let nativeShellIndex = queryItems.firstIndex(where: { $0.name == "nativeShell" }) {
      queryItems[nativeShellIndex] = URLQueryItem(name: "nativeShell", value: "markedit")
    } else {
      queryItems.append(URLQueryItem(name: "nativeShell", value: "markedit"))
    }
    if let displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !displayName.isEmpty {
      if let nameIndex = queryItems.firstIndex(where: { $0.name == "name" }) {
        queryItems[nameIndex] = URLQueryItem(name: "name", value: displayName)
      } else {
        queryItems.append(URLQueryItem(name: "name", value: displayName))
      }
    }
    components.queryItems = queryItems
    components.percentEncodedFragment = nil
    return components.url ?? url
  }

  private func markEditNativeShellURLForCurrentAccount(_ url: URL?) -> URL? {
    Self.markEditNativeShellURL(url, displayName: activeAccount?.displayName)
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
      let activeSharedBinding = sharedBinding?.syncEnabled == true ? sharedBinding : nil
      let opened = try LocalMarkdownDocument.open(fileURL: url, shared: activeSharedBinding != nil)
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
      clearVersionHistoryState()
      retainedCloudCopyAvailable = sharedBinding?.syncEnabled == false
      embeddedCollabURL = nil
      pendingDiskIngestion = nil
      pendingSharedMarkdown = nil
      let storedBaseline = try? baselineStore.loadBaseline(fileURL: url)
      lastProjectedMarkdown = storedBaseline?.lastProjectedMarkdown ?? opened.markdownForSave()
      if let persistedConflict = try? conflictStore.load(fileURL: url) {
        let bindingURL = activeSharedBinding.flatMap { markEditNativeShellURLForCurrentAccount($0.appEditorURL) }
        let normalizedConflict = persistedConflict.withSharedEditorURL(
          markEditNativeShellURLForCurrentAccount(persistedConflict.sharedEditorURL) ?? bindingURL
        )
        embeddedCollabURL = normalizedConflict.sharedEditorURL
        setConflict(normalizedConflict, status: "Conflict: review required before syncing resumes.")
      } else if let sharedBinding = activeSharedBinding {
        clearConflictState()
        embeddedCollabURL = markEditNativeShellURLForCurrentAccount(sharedBinding.appEditorURL)
        retainedCloudCopyAvailable = false
        registerSharedSession(
          fileURL: url,
          docId: sharedBinding.docId,
          branchId: sharedBinding.branchId,
          status: storedBaseline == nil ? .syncing : .synced,
          lastSyncAt: storedBaseline == nil ? nil : lastSyncDate(fileURL: url)
        )
        statusText = storedBaseline == nil
          ? "Joined shared document \(sharedBinding.docId). Waiting for shared content."
          : "Joined shared document \(sharedBinding.docId)."
        Task {
          await refreshManagedAccessLinksFromServer()
        }
      } else if sharedBinding != nil {
        clearConflictState()
        retainedCloudCopyAvailable = true
        lastProjectedMarkdown = opened.markdownForSave()
        statusText = "Editing \(url.lastPathComponent). Cloud copy and online versions are retained."
      } else {
        clearConflictState()
        retainedCloudCopyAvailable = false
        statusText = "Editing \(url.lastPathComponent)."
      }
      if embeddedCollabURL != nil {
        sessionManager.attachWindow(fileURL: url)
      }
      startFileWatcher(for: url)
    } catch {
      statusText = "Unable to open Markdown file."
    }
  }

  func openSharedLink() {
    guard requireSignedInForNativeSharedDocumentOpen() else { return }
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
    guard requireSignedInForNativeSharedDocumentOpen() else { return }
    do {
      let link = try NativeSharedDocumentLink.parse(url)
      try promptForSharedDocumentTarget(link: link)
    } catch {
      statusText = Self.sharedDocumentJoinStatus(for: error)
    }
  }

  func handleOpenURL(_ url: URL) {
    if let callback = NativeAuthCallback.parse(url, hostedDefaults: hostedDefaults) {
      completeSignIn(from: callback)
      return
    }
    if url.scheme == "marklab", url.host == "auth", url.path == "/callback" {
      statusText = "Sign-in failed. Try again from Settings."
      return
    }
    openSharedLink(from: url)
  }

  func openSignInPage() {
    NSWorkspace.shared.open(signInURL)
  }

  static func defaultSignInPrompt(url: URL, reason: NativeSignInPromptReason) {
    let alert = NSAlert()
    alert.messageText = "Sign In Required"
    alert.informativeText = switch reason {
    case .startSharing:
      "Sign in with Google before sharing Markdown files from MarkLab.app."
    case .openSharedDocument:
      "Sign in with Google before opening shared documents in MarkLab.app."
    }
    alert.addButton(withTitle: "Continue with Google")
    alert.addButton(withTitle: "Cancel")
    if alert.runModal() == .alertFirstButtonReturn {
      NSWorkspace.shared.open(url)
    }
  }

  private func promptSignIn(reason: NativeSignInPromptReason) {
    let url = signInURL
    statusText = switch reason {
    case .startSharing:
      "Sign in before sharing from MarkLab.app."
    case .openSharedDocument:
      "Sign in before opening shared documents in MarkLab.app."
    }
    signInPrompt(url, reason)
  }

  func signOut() {
    let account = activeAccount
    applySignedOutState(status: "Signed out. Sign in before sharing.", clearStore: true, broadcast: account?.token != nil, broadcastToken: account?.token)
    guard let account else { return }
    Task { @MainActor in
      let client = NativeAccountClient(
        apiBaseURL: account.apiBaseURL,
        bearerToken: account.token,
        transport: accountTransport
      )
      try? await client.logout()
    }
  }

  private func applySignedOutState(status: String, clearStore: Bool, broadcast: Bool, broadcastToken: String? = nil) {
    if clearStore {
      try? accountStore?.clear()
    }
    activeAccount = nil
    hostedShareController = nil
    nativeBearerToken = nil
    embeddedCollabURL = nil
    activeCollaborators = []
    managedAccessLinks = []
    latestLink = nil
    latestGrantId = nil
    pendingDiskIngestion = nil
    pendingSharedMarkdown = nil
    projectionTask?.cancel()
    projectionTask = nil
    if clearStore {
      sessionManager.removeAllSessions()
    }
    if let fileURL = document?.fileURL {
      if !clearStore {
        sessionManager.removeSession(fileURL: fileURL)
      }
      MarkLabBackgroundSharedDocumentHost.shared.release(fileURL: fileURL)
    }
    statusText = status
    if broadcast {
      var userInfo: [String: String] = [:]
      if let broadcastToken {
        userInfo[NativeAccountSignOutNotification.tokenKey] = broadcastToken
      }
      NotificationCenter.default.post(name: .markLabAccountDidSignOut, object: nil, userInfo: userInfo)
    }
  }

  private func applySignedInState(_ account: NativeStoredAccount, status: String) {
    activeAccount = account
    nativeBearerToken = account.token
    hostedShareController = Self.makeHostedShareController(from: account, transport: accountTransport)
    statusText = status
  }

  private func requireSignedInForNativeSharedDocumentOpen() -> Bool {
    guard isSignedIn else {
      promptSignIn(reason: .openSharedDocument)
      return false
    }
    return true
  }

  private func completeSignIn(from callback: NativeAuthCallback) {
    statusText = "Finishing sign-in..."
    Task { @MainActor in
      do {
        guard let expectedAppState = try accountStore?.loadPendingAuthState(), expectedAppState == callback.appState else {
          try? accountStore?.clearPendingAuthState()
          statusText = "Sign-in failed. Try again from Settings."
          return
        }
        let client = NativeAccountClient(
          apiBaseURL: callback.apiBaseURL,
          bearerToken: callback.token,
          transport: accountTransport
        )
        let user = try await client.currentUser()
        let workspaces = try await client.listWorkspaces()
        let workspace: NativeWorkspaceSummary
        if let existing = workspaces.first(where: { $0.role == "Owner" }) ?? workspaces.first {
          workspace = existing
        } else {
          workspace = try await client.createWorkspace(name: "\(user.displayName) Workspace")
        }
        let account = NativeStoredAccount(
          apiBaseURL: callback.apiBaseURL,
          webBaseURL: callback.webBaseURL,
          token: callback.token,
          userId: user.userId,
          email: user.email,
          displayName: user.displayName,
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.name
        )
        try accountStore?.save(account)
        try? accountStore?.clearPendingAuthState()
        applySignedInState(account, status: "Signed in as \(account.displayName). Workspace: \(account.workspaceName).")
        NotificationCenter.default.post(
          name: .markLabAccountDidSignIn,
          object: nil,
          userInfo: [NativeAccountSignInNotification.tokenKey: account.token]
        )
      } catch {
        try? accountStore?.clearPendingAuthState()
        statusText = "Sign-in failed. Try again from Settings."
      }
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
    guard isSignedIn else {
      throw NativeSharedDocumentLinkError.signInRequired
    }
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
    let appEditorURL = markEditNativeShellURLForCurrentAccount(link.appEditorURL(localDocId: localDocId)) ?? link.appEditorURL(localDocId: localDocId)
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
    if existingBinding?.matches(link) != true {
      try baselineStore.clearBaseline(fileURL: localFileURL)
    }
    loadFile(localFileURL)
    embeddedCollabURL = appEditorURL
    latestLink = link.originalURL.absoluteString
    latestGrantId = nil
    managedAccessLinks = []
    activeCollaborators = []
    clearVersionHistoryState()
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
    case NativeSharedDocumentLinkError.signInRequired:
      return "Sign in before opening shared documents in MarkLab.app."
    default:
      return "Unable to open shared link."
    }
  }

  private static func localFileHasUserContent(_ url: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: url.path) else { return false }
    guard let data = try? Data(contentsOf: url) else { return false }
    return !data.isEmpty
  }

  @discardableResult
  func saveFile() throws -> Bool {
    if conflict != nil {
      statusText = "Resolve the conflict before saving."
      return false
    }
    localAutosaveTask?.cancel()
    localAutosaveTask = nil
    if embeddedCollabURL != nil {
      let projection = try flushPendingSharedProjection()
      if projection.openedConflict {
        statusText = "Resolve the conflict before saving."
        return false
      }
      return true
    }
    guard var currentDocument = document else { return false }
    currentDocument.replaceText(text)
    try currentDocument.save()
    document = currentDocument
    if !retainedCloudCopyAvailable {
      try updateProjectionBaseline(currentDocument.markdownForSave(), fileURL: currentDocument.fileURL)
    }
    statusText = "Saved \(currentDocument.fileURL.lastPathComponent)."
    return false
  }

  func saveFileFromUI() {
    do {
      let shouldCreateManualCheckpoint = try saveFile()
      if shouldCreateManualCheckpoint {
        Task { [weak self] in
          await self?.saveVersionSnapshot()
        }
      }
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
    applyLocalAutosaveEnabled(enabled, persist: true)
  }

  private func reloadLocalAutosaveSettingFromDefaults() {
    applyLocalAutosaveEnabled(Self.defaultLocalAutosaveEnabled(defaults: settingsDefaults), persist: false)
  }

  private func applyLocalAutosaveEnabled(_ enabled: Bool, persist: Bool) {
    if persist {
      settingsDefaults.set(enabled, forKey: MarkLabAppSettings.localAutosaveEnabledDefaultsKey)
    }
    guard localAutosaveEnabled != enabled else { return }
    localAutosaveEnabled = enabled
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
    if !retainedCloudCopyAvailable {
      try updateProjectionBaseline(currentDocument.markdownForSave(), fileURL: currentDocument.fileURL)
    }
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
    guard document != nil else {
      statusText = "Open a Markdown file before sharing."
      return
    }
    guard hostedShareController != nil else {
      promptSignIn(reason: .startSharing)
      return
    }
    do {
      _ = try await startSharingAndConnectThrowing()
      await refreshManagedAccessLinksFromServer()
    } catch {
      statusText = "Unable to start sharing."
    }
  }

  @discardableResult
  func startSharingAndConnectThrowing() async throws -> NativeHostedDocument {
    guard conflict == nil else {
      statusText = "Resolve the conflict before sharing."
      throw MarkLabNativeShareAutomationError.conflictOpen
    }
    guard let hostedShareController else { throw MarkLabNativeShareAutomationError.missingHostedShareController }
    guard let fileURL = document?.fileURL else { throw MarkLabNativeShareAutomationError.missingFile }
    try saveFile()
    if retainedCloudCopyAvailable,
       let binding = try? sharedDocumentBindingStore.loadBinding(fileURL: fileURL) {
      return try resumeRetainedCloudCopyAndConnect(
        fileURL: fileURL,
        binding: binding,
        hostedShareController: hostedShareController
      )
    }
    sessionManager.upsertSession(
      fileURL: fileURL,
      docId: "pending",
      branchId: "pending",
      status: .syncing,
      lastSyncAt: nil
    )
    do {
      let shared = try await hostedShareController.startSharing(fileURL: fileURL)
      latestLink = nil
      latestGrantId = nil
      managedAccessLinks = []
      activeCollaborators = []
      clearVersionHistoryState()
      let rawAppEditorURL = try hostedShareController.appEditorURL()
      let appEditorURL = markEditNativeShellURLForCurrentAccount(rawAppEditorURL) ?? rawAppEditorURL
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
      retainedCloudCopyAvailable = false
      embeddedCollabURL = appEditorURL
      registerSharedSession(
        fileURL: fileURL,
        docId: shared.docId,
        branchId: shared.branchId,
        status: .synced,
        lastSyncAt: Date()
      )
      statusText = "Shared \(fileURL.lastPathComponent) as \(shared.docId). App editor connected as workspace user."
      return shared
    } catch {
      sessionManager.removeSession(fileURL: fileURL)
      throw error
    }
  }

  @discardableResult
  private func resumeRetainedCloudCopyAndConnect(
    fileURL: URL,
    binding: NativeSharedDocumentBinding,
    hostedShareController: NativeHostedShareController
  ) throws -> NativeHostedDocument {
    let baselineMarkdown = (try? baselineStore.loadBaseline(fileURL: fileURL)?.lastProjectedMarkdown)
      ?? lastProjectedMarkdown
      ?? LocalMarkdownDocument.normalizeForSharedSave(text)
    let localMarkdown = try LocalMarkdownDocument.open(fileURL: fileURL, shared: true).markdownForSave()
    hostedShareController.restoreSharedDocument(from: binding, suggestedFilename: fileURL.lastPathComponent)
    let rawAppEditorURL = try hostedShareController.appEditorURL()
    let appEditorURL = markEditNativeShellURLForCurrentAccount(rawAppEditorURL) ?? rawAppEditorURL
    let resumed = NativeHostedDocument(
      docId: binding.docId,
      branchId: binding.branchId,
      versionId: "",
      hash: binding.baselineHash
    )
    try sharedDocumentBindingStore.saveBinding(binding.withSyncEnabled(true, appEditorURL: appEditorURL), fileURL: fileURL)
    latestLink = nil
    latestGrantId = nil
    managedAccessLinks = []
    activeCollaborators = []
    clearVersionHistoryState()
    retainedCloudCopyAvailable = false
    embeddedCollabURL = appEditorURL
    diskIngestionRevision += 1
    pendingDiskIngestion = PendingDiskIngestion(
      revision: diskIngestionRevision,
      markdown: localMarkdown,
      baselineMarkdown: baselineMarkdown,
      conflictOnFailure: nil
    )
    registerSharedSession(
      fileURL: fileURL,
      docId: binding.docId,
      branchId: binding.branchId,
      status: .syncing,
      lastSyncAt: nil
    )
    statusText = "Resumed sharing \(fileURL.lastPathComponent). Waiting to sync local file."
    return resumed
  }

  func createLink(role: NativeLinkRole) {
    guard conflict == nil else {
      statusText = "Resolve the conflict before creating a link."
      return
    }
    Task {
      do {
        _ = try await createLinkAndCopy(role: role)
      } catch {
        statusText = "Unable to create \(role.rawValue) link."
      }
    }
  }

  func createLinkAndCopy(role: NativeLinkRole) async throws -> NativeHostedShareLink {
    guard conflict == nil else { throw MarkLabNativeShareAutomationError.conflictOpen }
    guard let hostedShareController else { throw MarkLabNativeShareAutomationError.missingHostedShareController }
    let link = try await hostedShareController.createLink(role: role)
    latestLink = link.url.absoluteString
    latestGrantId = link.grantId
    upsertManagedAccessLink(NativeManagedAccessLink(link: link))
    copyLinkToPasteboard(link.url.absoluteString)
    statusText = Self.linkCopiedStatusText(role: role)
    return link
  }

  func createShareLinkForCLI(fileURL: URL, role: NativeLinkRole) async throws -> NativeCLIShareServiceResult {
    if document?.fileURL.standardizedFileURL.path != fileURL.standardizedFileURL.path {
      loadFile(fileURL)
    }
    guard document?.fileURL.path == fileURL.path else { throw MarkLabNativeShareAutomationError.missingFile }
    if embeddedCollabURL == nil {
      _ = try await startSharingAndConnectThrowing()
    }
    let link = try await createLinkAndCopy(role: role)
    guard let binding = try sharedDocumentBindingStore.loadBinding(fileURL: fileURL) else {
      throw MarkLabNativeShareAutomationError.missingSharedBinding
    }
    return NativeCLIShareServiceResult(
      link: link,
      docId: binding.docId,
      branchId: binding.branchId,
      copied: true,
      opened: false
    )
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
      let projection = try flushPendingSharedProjection()
      guard !projection.openedConflict, conflict == nil else {
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
    retainedCloudCopyAvailable = true
    latestLink = nil
    latestGrantId = nil
    managedAccessLinks = []
    activeCollaborators = []
    clearVersionHistoryState()
    lastProjectedMarkdown = nil

    if let fileURL {
      if let binding = try? sharedDocumentBindingStore.loadBinding(fileURL: fileURL) {
        try? sharedDocumentBindingStore.saveBinding(binding.withSyncEnabled(false), fileURL: fileURL)
      }
      sessionManager.removeSession(fileURL: fileURL)
      MarkLabBackgroundSharedDocumentHost.shared.release(fileURL: fileURL)
      if let localDocument = try? LocalMarkdownDocument.open(fileURL: fileURL, shared: false) {
        document = localDocument
        text = localDocument.text
        filePath = fileURL.path
      }
      let filename = fileURL.lastPathComponent
      statusText = revokeFailures == 0
        ? "Stopped sharing \(filename). Cloud copy and online versions are retained."
        : "Stopped sharing \(filename), but some links could not be revoked. Cloud copy is retained."
    } else {
      statusText = revokeFailures == 0
        ? "Stopped sharing. Cloud copy and online versions are retained."
        : "Stopped sharing, but some links could not be revoked. Cloud copy is retained."
    }
  }

  func deleteCloudCopy() async {
    guard hasCloudCopyReference else { return }
    guard canDeleteCloudCopy else {
      statusText = "Type DELETE CLOUD COPY before deleting the hosted copy."
      return
    }
    guard conflict == nil else {
      statusText = "Resolve the conflict before deleting the cloud copy."
      return
    }
    guard let hostedShareController else {
      statusText = "Open a file with a cloud copy before deleting it."
      return
    }

    let fileURL = document?.fileURL
    do {
      let projection = try flushPendingSharedProjection()
      guard !projection.openedConflict else {
        statusText = "Resolve the conflict before deleting the cloud copy."
        return
      }
      _ = try await hostedShareController.deleteCloudCopy()
    } catch {
      statusText = Self.versionHistoryStatus(for: error)
      return
    }

    projectionTask?.cancel()
    projectionTask = nil
    pendingSharedMarkdown = nil
    pendingDiskIngestion = nil
    embeddedCollabURL = nil
    retainedCloudCopyAvailable = false
    latestLink = nil
    latestGrantId = nil
    managedAccessLinks = []
    activeCollaborators = []
    clearVersionHistoryState()
    deleteCloudCopyConfirmation = ""
    lastProjectedMarkdown = nil

    if let fileURL {
      try? sharedDocumentBindingStore.clearBinding(fileURL: fileURL)
      try? baselineStore.clearBaseline(fileURL: fileURL)
      sessionManager.removeSession(fileURL: fileURL)
      MarkLabBackgroundSharedDocumentHost.shared.release(fileURL: fileURL)
      if let localDocument = try? LocalMarkdownDocument.open(fileURL: fileURL, shared: false) {
        document = localDocument
        text = localDocument.text
        filePath = fileURL.path
      }
      statusText = "Deleted cloud copy for \(fileURL.lastPathComponent). Local file stays on disk."
    } else {
      statusText = "Deleted cloud copy. Local file stays on disk."
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

  func loadVersionHistory(createAutosaveCheckpoint: Bool = true) async {
    guard let hostedShareController, hasCloudCopyReference else {
      statusText = "Open a file with a cloud copy before viewing online version history."
      return
    }
    versionHistoryRequestRevision += 1
    let requestRevision = versionHistoryRequestRevision
    let expectedFileURL = document?.fileURL
    isLoadingVersions = true
    defer {
      if requestRevision == versionHistoryRequestRevision {
        isLoadingVersions = false
      }
    }
    do {
      if createAutosaveCheckpoint, conflict == nil {
        _ = try? await hostedShareController.autosaveVersion()
      }
      let versions = try await hostedShareController.listVersions()
      guard requestRevision == versionHistoryRequestRevision,
            document?.fileURL == expectedFileURL,
            hasCloudCopyReference
      else { return }
      versionHistory = versions
      if let selectedVersionId,
         versions.contains(where: { $0.versionId == selectedVersionId }) {
        // Keep the current selection.
      } else {
        selectedVersionId = versions.first?.versionId
        selectedVersion = nil
      }
      statusText = versions.isEmpty ? "No online versions yet." : "Loaded \(versions.count) online version\(versions.count == 1 ? "" : "s")."
    } catch {
      guard requestRevision == versionHistoryRequestRevision else { return }
      statusText = Self.versionHistoryStatus(for: error)
    }
  }

  func previewVersion(_ versionId: String) async {
    guard let hostedShareController, hasCloudCopyReference else {
      statusText = "Open a file with a cloud copy before previewing online versions."
      return
    }
    let expectedFileURL = document?.fileURL
    selectedVersionId = versionId
    restoreVersionConfirmation = ""
    do {
      let snapshot = try await hostedShareController.showVersion(versionId: versionId)
      guard selectedVersionId == versionId,
            document?.fileURL == expectedFileURL,
            hasCloudCopyReference
      else { return }
      selectedVersion = snapshot
      statusText = "Previewing version \(selectedVersion?.versionNumber ?? 0)."
    } catch {
      guard selectedVersionId == versionId else { return }
      selectedVersion = nil
      statusText = Self.versionHistoryStatus(for: error)
    }
  }

  func saveVersionSnapshot() async {
    guard let hostedShareController, embeddedCollabURL != nil else {
      statusText = "Start sharing before saving an online version."
      return
    }
    guard conflict == nil else {
      statusText = "Resolve the conflict before saving a version."
      return
    }
    do {
      let projection = try flushPendingSharedProjection()
      guard !projection.openedConflict else {
        statusText = "Resolve the conflict before saving a version."
        return
      }
      let result = try await hostedShareController.saveVersion()
      await loadVersionHistory(createAutosaveCheckpoint: false)
      selectedVersionId = result.versionId
      await previewVersion(result.versionId)
      statusText = result.created
        ? "Saved version \(result.versionNumber)."
        : "Version \(result.versionNumber) is already current."
    } catch {
      statusText = Self.versionHistoryStatus(for: error)
    }
  }

  func restoreSelectedVersion() async {
    guard canApplySelectedVersionRestore, let selectedVersionId else {
      statusText = "Preview a version and type RESTORE before restoring."
      return
    }
    guard let hostedShareController else {
      statusText = "Start sharing before restoring an online version."
      return
    }
    guard let sourceSnapshot = selectedVersion,
          sourceSnapshot.versionId == selectedVersionId
    else {
      statusText = "Preview a version before restoring."
      return
    }
    do {
      let projection = try flushPendingSharedProjection()
      guard !projection.openedConflict else {
        statusText = "Resolve the conflict before restoring a version."
        return
      }
      let result = try await hostedShareController.restoreVersion(versionId: selectedVersionId)
      let restoredSnapshot = try await hostedShareController.showVersion(versionId: result.versionId)
      guard restoredSnapshot.versionId == result.versionId,
            NativeProjectionBaselineRecord.markdownHash(restoredSnapshot.markdown) == result.hash
      else {
        throw NativeVersionHistoryError.restoreFailed
      }
      projectionTask?.cancel()
      projectionTask = nil
      pendingSharedMarkdown = nil
      restoreVersionConfirmation = ""
      selectedVersion = nil
      let localProjection = try projectSharedMarkdownImmediately(restoredSnapshot.markdown)
      guard !localProjection.openedConflict else {
        statusText = "Resolve the conflict before restoring a version."
        return
      }
      reloadEmbeddedCollabEditor()
      await loadVersionHistory(createAutosaveCheckpoint: false)
      self.selectedVersionId = result.versionId
      selectedVersion = restoredSnapshot
      statusText = "Restored version \(result.versionNumber). The local file will update through shared projection."
    } catch {
      statusText = Self.versionHistoryStatus(for: error)
    }
  }

  private func reloadEmbeddedCollabEditor() {
    guard let url = embeddedCollabURL,
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else {
      return
    }
    var items = components.queryItems ?? []
    items.removeAll { $0.name == "nativeReload" }
    items.append(URLQueryItem(name: "nativeReload", value: UUID().uuidString))
    components.queryItems = items
    components.percentEncodedFragment = nil
    embeddedCollabURL = components.url ?? url
  }

  private func clearVersionHistoryState() {
    versionHistoryRequestRevision += 1
    versionHistory = []
    selectedVersionId = nil
    selectedVersion = nil
    restoreVersionConfirmation = ""
    deleteCloudCopyConfirmation = ""
    isLoadingVersions = false
  }

  private static func versionHistoryStatus(for error: Error) -> String {
    switch error {
    case NativeVersionHistoryError.forbidden:
      return "Unable to access version history for this document."
    case NativeVersionHistoryError.staleOrMissingVersion:
      return "Selected version is no longer available."
    case NativeVersionHistoryError.unavailable:
      return "Version history is temporarily unavailable."
    case NativeVersionHistoryError.restoreFailed:
      return "Unable to restore selected version."
    default:
      return "Unable to load version history."
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
      _ = try flushPendingSharedProjection()
    } catch {
      statusText = "Unable to project shared Markdown to disk."
    }
  }

  func flushPendingSharedProjection() throws -> SharedProjectionResult {
    guard let markdown = pendingSharedMarkdown else { return .noPending }
    projectionTask?.cancel()
    projectionTask = nil
    pendingSharedMarkdown = nil
    return try projectSharedMarkdownImmediately(markdown)
  }

  func projectSharedMarkdownImmediately(_ markdown: String) throws -> SharedProjectionResult {
    guard var currentDocument = document else { return .noPending }
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
      return .conflictOpened
    }
    currentDocument.replaceText(markdown)
    try currentDocument.save()
    document = currentDocument
    text = markdown
    try updateProjectionBaseline(currentDocument.markdownForSave(), fileURL: currentDocument.fileURL)
    statusText = "Projected shared Markdown to \(currentDocument.fileURL.lastPathComponent)."
    return .applied
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
      sessionManager.markStatus(fileURL: currentDocument.fileURL, .syncing)
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
      embeddedCollabURL = markEditNativeShellURLForCurrentAccount(url)
      return true
    }
    return false
  }

  func handleDiskIngestionBridgeResult(_ result: DiskIngestionBridgeResult) {
    guard let pending = pendingDiskIngestion, pending.revision == result.revision else { return }
    let providerAlreadyMatchesLocal = result.reason == "provider_changed"
      && result.providerMarkdown.map {
        LocalMarkdownDocument.normalizeForSharedSave($0)
          == LocalMarkdownDocument.normalizeForSharedSave(result.markdown)
      } == true
    let acceptedMarkdown = providerAlreadyMatchesLocal ? (result.providerMarkdown ?? result.markdown) : result.markdown
    if result.ok || providerAlreadyMatchesLocal {
      if let fileURL = document?.fileURL {
        do {
          if let conflictOnFailure = pending.conflictOnFailure,
             !refreshConflictIfDiskChanged(conflictOnFailure, sharedMarkdown: acceptedMarkdown) {
            pendingDiskIngestion = nil
            return
          }
          if var currentDocument = document {
            let expectedDiskMarkdown = pending.conflictOnFailure?.localMarkdown ?? result.markdown
            currentDocument.replaceText(acceptedMarkdown)
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
          text = acceptedMarkdown
          try updateProjectionBaseline(acceptedMarkdown, fileURL: fileURL)
        } catch {
          if let conflictOnFailure = pending.conflictOnFailure {
            setConflict(conflictOnFailure, status: "Unable to persist local disk change.")
          }
          statusText = "Unable to persist local disk change."
          return
        }
      } else {
        text = acceptedMarkdown
        lastProjectedMarkdown = acceptedMarkdown
      }
      pendingDiskIngestion = nil
      clearConflictState()
      statusText = providerAlreadyMatchesLocal
        ? "Shared editor already matches local file."
        : "Ingested local disk change into the shared editor."
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

  private func setConflict(_ nextConflict: MarkLabConflict, status: String) {
    let persistedConflict = nextConflict.withSharedEditorURL(storableConflictSharedEditorURL(embeddedCollabURL))
    conflict = persistedConflict
    resolvedConflictMarkdown = ""
    resolvedConflictConfirmation = ""
    if let fileURL = document?.fileURL {
      try? conflictStore.save(persistedConflict, fileURL: fileURL)
      sessionManager.markStatus(fileURL: fileURL, .conflict)
    }
    statusText = status
  }

  private func storableConflictSharedEditorURL(_ url: URL?) -> URL? {
    guard let url = markEditNativeShellURLForCurrentAccount(url),
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
    if embeddedCollabURL != nil {
      sessionManager.markSynced(fileURL: fileURL)
    }
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

  private func registerSharedSession(
    fileURL: URL,
    docId: String,
    branchId: String,
    status: NativeSharedDocumentSyncStatus,
    lastSyncAt: Date?
  ) {
    sessionManager.upsertSession(
      fileURL: fileURL,
      docId: docId,
      branchId: branchId,
      status: status,
      lastSyncAt: lastSyncAt
    )
  }

  private func lastSyncDate(fileURL: URL) -> Date? {
    guard let updatedAt = try? baselineStore.loadBaseline(fileURL: fileURL)?.updatedAt else { return nil }
    return ISO8601DateFormatter().date(from: updatedAt)
  }

  func detachSharedWindow() {
    guard let fileURL = document?.fileURL, embeddedCollabURL != nil else { return }
    sessionManager.detachWindow(fileURL: fileURL)
  }

  var hasHostedShareController: Bool {
    hostedShareController != nil
  }

  fileprivate static func makeHostedShareController(from config: NativeCLIHostedConfig?) -> NativeHostedShareController? {
    if let config {
      guard
        let apiURL = URL(string: config.apiBaseURL),
        let webURL = URL(string: config.webBaseURL),
        !config.bearerToken.isEmpty,
        !config.workspaceId.isEmpty
      else {
        return nil
      }
      return NativeHostedShareController(
        client: NativeControlPlaneShareClient(
          apiBaseURL: apiURL,
          webBaseURL: webURL,
          bearerToken: config.bearerToken,
          workspaceId: config.workspaceId
        )
      )
    }
    return makeHostedShareControllerFromEnvironment()
  }

  fileprivate static func makeHostedShareController(
    from account: NativeStoredAccount,
    transport: NativeHTTPTransport = URLSessionNativeHTTPTransport()
  ) -> NativeHostedShareController {
    NativeHostedShareController(
      client: NativeControlPlaneShareClient(
        apiBaseURL: account.apiBaseURL,
        webBaseURL: account.webBaseURL,
        bearerToken: account.token,
        workspaceId: account.workspaceId,
        transport: transport
      )
    )
  }

  fileprivate static func makeHostedShareControllerFromEnvironment() -> NativeHostedShareController? {
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

enum MarkLabNativeShareAutomationError: Error {
  case conflictOpen
  case missingHostedShareController
  case missingFile
  case missingSharedBinding
}

final class NativeCLIShareAppService: NativeCLIShareService {
  private let fixedModel: MarkLabAppModel?
  private let backgroundHost: MarkLabBackgroundSharedDocumentHost
  private let makeHostedShareController: @MainActor (NativeCLIHostedConfig?) -> NativeHostedShareController?
  private let makeModel: @MainActor (NativeHostedShareController?, String?) -> MarkLabAppModel
  private var inFlightFileKeys: Set<String> = []

  init(model: MarkLabAppModel, backgroundHost: MarkLabBackgroundSharedDocumentHost = .shared) {
    fixedModel = model
    self.backgroundHost = backgroundHost
    makeHostedShareController = { _ in nil }
    makeModel = { _, _ in model }
  }

  init(
    backgroundHost: MarkLabBackgroundSharedDocumentHost = .shared,
    makeHostedShareController: @escaping @MainActor (NativeCLIHostedConfig?) -> NativeHostedShareController? = MarkLabAppModel.makeHostedShareController(from:),
    makeModel: @escaping @MainActor (NativeHostedShareController?, String?) -> MarkLabAppModel
  ) {
    fixedModel = nil
    self.backgroundHost = backgroundHost
    self.makeHostedShareController = makeHostedShareController
    self.makeModel = makeModel
  }

  func createShareLink(for request: NativeCLIShareServiceRequest) async throws -> NativeCLIShareServiceResult {
    let key = canonicalKey(request.fileURL)
    while inFlightFileKeys.contains(key) {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    inFlightFileKeys.insert(key)
    defer { inFlightFileKeys.remove(key) }
    let hostedShareController = makeHostedShareController(request.hostedConfig)
    let nativeBearerToken = nativeBearerToken(from: request.hostedConfig, hostedShareController: hostedShareController)
    let retainedModel = fixedModel ?? backgroundHost.retainedModel(fileURL: request.fileURL)
    let model: MarkLabAppModel
    if let fixedModel {
      model = fixedModel
    } else if request.hostedConfig != nil {
      model = makeModel(hostedShareController, nativeBearerToken)
    } else if retainedModel?.hasHostedShareController == true || hostedShareController == nil {
      model = retainedModel ?? makeModel(nil, nil)
    } else {
      model = makeModel(hostedShareController, nativeBearerToken)
    }
    let result = try await model.createShareLinkForCLI(fileURL: request.fileURL, role: request.role)
    backgroundHost.retain(model, fileURL: request.fileURL)
    return result
  }

  func joinSharedDocument(for request: NativeCLIJoinServiceRequest) async throws -> NativeCLIJoinServiceResult {
    let key = canonicalKey(request.fileURL)
    while inFlightFileKeys.contains(key) {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    inFlightFileKeys.insert(key)
    defer { inFlightFileKeys.remove(key) }
    let model = fixedModel ?? backgroundHost.retainedModel(fileURL: request.fileURL) ?? makeModel(nil, nil)
    let link = try NativeSharedDocumentLink.parse(request.link)
    try model.joinSharedDocument(link: link, localFileURL: request.fileURL)
    backgroundHost.retain(model, fileURL: request.fileURL)
    return NativeCLIJoinServiceResult(docId: link.docId, branchId: link.branchId, opened: false)
  }

  private func nativeBearerToken(
    from config: NativeCLIHostedConfig?,
    hostedShareController: NativeHostedShareController?
  ) -> String? {
    guard hostedShareController != nil else { return nil }
    if let token = config?.bearerToken, !token.isEmpty {
      return token
    }
    return ProcessInfo.processInfo.environment["MARKLAB_USER_TOKEN"]
  }

  private func canonicalKey(_ fileURL: URL) -> String {
    fileURL.standardizedFileURL.path
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
        model.handleOpenURL(url)
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
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.addUserScript(WKUserScript(
      source: HostedCollabWebView.nativeMarkerUserScript(),
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    ))
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
      webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
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

  fileprivate static func nativeMarkerUserScript() -> String {
    """
    (() => {
      window.__marklabNativeApp = true;
    })();
    """
  }

  fileprivate static func authFetchUserScript(_ bearerToken: String) -> String {
    let escapedToken = javascriptStringLiteral(bearerToken)
    return """
    (() => {
      const marklabNativeBearerToken = \(escapedToken);
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

  static func nativeMarkerUserScriptForTesting() -> String {
    nativeMarkerUserScript()
  }

  static func authFetchUserScriptForTesting(_ bearerToken: String) -> String {
    authFetchUserScript(bearerToken)
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
        return
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
