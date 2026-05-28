import AppKit
import SwiftUI
import MarkLabMacOS

@main
struct MarkLabApp: App {
  @NSApplicationDelegateAdaptor(MarkLabAppDelegate.self) private var appDelegate
  private let launchFileURL = MarkLabLaunchFile.url(from: CommandLine.arguments)
  private let updaterController = MarkLabSparkleUpdater.makeControllerIfConfigured()

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
      MarkLabUpdateCommands(updater: updaterController?.updater)
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
