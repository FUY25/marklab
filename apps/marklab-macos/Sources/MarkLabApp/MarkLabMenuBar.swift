import AppKit
import Foundation
import MarkLabMacOS

enum MarkLabBrandAssets {
  static let statusTemplateResourceName = "MarkLabStatusTemplate"

  static func statusTemplateURL(bundle: Bundle = .module) -> URL? {
    bundle.url(
      forResource: statusTemplateResourceName,
      withExtension: "png",
      subdirectory: "Brand"
    ) ?? bundle.url(
      forResource: statusTemplateResourceName,
      withExtension: "png"
    )
  }

  static func statusItemImage(bundle: Bundle = .module) -> NSImage {
    if let url = statusTemplateURL(bundle: bundle), let image = NSImage(contentsOf: url) {
      image.isTemplate = true
      image.size = NSSize(width: 18, height: 18)
      image.accessibilityDescription = "MarkLab"
      return image
    }

    return NSImage(systemSymbolName: "link", accessibilityDescription: "MarkLab") ?? NSImage()
  }
}

struct MarkLabMenuBarDocumentRow: Equatable, Identifiable {
  let id: String
  let fileURL: URL
  let title: String
  let statusLabel: String
  let statusSystemImage: String
  let lastSyncLabel: String
}

@MainActor
final class MarkLabMenuBarViewModel {
  private let openDocument: (URL) -> Void
  private let now: () -> Date

  init(openDocument: @escaping (URL) -> Void, now: @escaping () -> Date = Date.init) {
    self.openDocument = openDocument
    self.now = now
  }

  func rows(from sessions: [NativeSharedDocumentSession]) -> [MarkLabMenuBarDocumentRow] {
    sessions.map { session in
      MarkLabMenuBarDocumentRow(
        id: session.id,
        fileURL: session.fileURL,
        title: session.fileURL.lastPathComponent,
        statusLabel: statusLabel(session.status),
        statusSystemImage: statusSystemImage(session.status),
        lastSyncLabel: lastSyncLabel(for: session)
      )
    }
  }

  func emptyTitle(for sessions: [NativeSharedDocumentSession]) -> String? {
    sessions.isEmpty ? "No Shared Documents" : nil
  }

  func open(_ row: MarkLabMenuBarDocumentRow) {
    openDocument(row.fileURL)
  }

  private func statusLabel(_ status: NativeSharedDocumentSyncStatus) -> String {
    switch status {
    case .syncing:
      return "Syncing"
    case .synced:
      return "Synced"
    case .offline:
      return "Offline"
    case .conflict:
      return "Conflict"
    case .error:
      return "Error"
    }
  }

  private func statusSystemImage(_ status: NativeSharedDocumentSyncStatus) -> String {
    switch status {
    case .synced:
      return "circle.fill"
    case .syncing:
      return "arrow.triangle.2.circlepath"
    case .offline:
      return "circle"
    case .conflict:
      return "exclamationmark.triangle.fill"
    case .error:
      return "xmark.circle.fill"
    }
  }

  private func lastSyncLabel(for session: NativeSharedDocumentSession) -> String {
    guard let lastSyncAt = session.lastSyncAt else {
      return "\(statusLabel(session.status)) now"
    }
    let elapsed = max(0, now().timeIntervalSince(lastSyncAt))
    if elapsed < 60 {
      return "\(statusLabel(session.status)) now"
    }
    if elapsed < 3600 {
      return "\(statusLabel(session.status)) \(Int(elapsed / 60))m ago"
    }
    return "\(statusLabel(session.status)) \(Int(elapsed / 3600))h ago"
  }
}

@MainActor
final class MarkLabMenuBarController: NSObject {
  private let statusItem: NSStatusItem
  private let sessionManager: NativeSharedDocumentSessionManager
  private let viewModel: MarkLabMenuBarViewModel
  private var listenerId: UUID?

  init(sessionManager: NativeSharedDocumentSessionManager = .shared) {
    self.sessionManager = sessionManager
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    viewModel = MarkLabMenuBarViewModel(openDocument: { fileURL in
      _ = MarkEditDocumentWindowCoordinator.shared.openDocumentWindow(fileURL: fileURL)
    })
    super.init()
    statusItem.button?.title = "MarkLab"
    statusItem.button?.image = MarkLabBrandAssets.statusItemImage()
    listenerId = sessionManager.addListener { [weak self] in
      self?.reloadMenu()
    }
    reloadMenu()
  }

  deinit {
    if let listenerId {
      Task { @MainActor [sessionManager] in
        sessionManager.removeListener(listenerId)
      }
    }
  }

  private func reloadMenu() {
    let menu = NSMenu()
    let sessions = sessionManager.sessions
    let rows = viewModel.rows(from: sessions)
    if let emptyTitle = viewModel.emptyTitle(for: sessions) {
      let item = NSMenuItem(title: emptyTitle, action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
    } else {
      for row in rows {
        let item = NSMenuItem(
          title: "\(row.title)  \(row.statusLabel)  \(row.lastSyncLabel)",
          action: #selector(openDocument(_:)),
          keyEquivalent: ""
        )
        item.target = self
        item.representedObject = row
        menu.addItem(item)
      }
    }
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Open MarkLab", action: #selector(openMarkLab), keyEquivalent: ""))
    statusItem.menu = menu
  }

  @objc private func openDocument(_ sender: NSMenuItem) {
    guard let row = sender.representedObject as? MarkLabMenuBarDocumentRow else { return }
    viewModel.open(row)
  }

  @objc private func openMarkLab() {
    NSApp.activate(ignoringOtherApps: true)
  }
}
