import AppKit
import SwiftUI

@MainActor
final class MarkLabBackgroundSharedDocumentHost {
  static let shared = MarkLabBackgroundSharedDocumentHost()

  private let createHiddenWindow: Bool
  private var retainedModels: [String: MarkLabAppModel] = [:]
  private var hiddenControllers: [String: NSWindowController] = [:]

  init(createHiddenWindow: Bool = true) {
    self.createHiddenWindow = createHiddenWindow
  }

  var retainedFileURLs: [URL] {
    retainedModels.values
      .compactMap { $0.fileURLForBackgroundRetention }
      .sorted { $0.path < $1.path }
  }

  func retainedModel(fileURL: URL) -> MarkLabAppModel? {
    retainedModels[canonicalKey(fileURL)]
  }

  func retain(_ model: MarkLabAppModel, fileURL: URL) {
    let key = canonicalKey(fileURL)
    if let retainedModel = retainedModels[key], retainedModel !== model {
      hiddenControllers[key]?.close()
      hiddenControllers[key] = nil
    }
    retainedModels[key] = model
    guard createHiddenWindow, hiddenControllers[key] == nil else { return }
    let rootView = MarkEditDocumentShellView(model: model, retainsSharedDocumentOnDisappear: false)
    let hostingController = NSHostingController(rootView: rootView)
    let window = NSWindow(contentViewController: hostingController)
    window.title = "MarkLab Background Sync"
    window.styleMask = [.borderless]
    window.setFrame(NSRect(x: -10_000, y: -10_000, width: 640, height: 480), display: false)
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    let controller = NSWindowController(window: window)
    hiddenControllers[key] = controller
    _ = hostingController.view
  }

  func release(fileURL: URL) {
    let key = canonicalKey(fileURL)
    hiddenControllers[key]?.close()
    hiddenControllers[key] = nil
    retainedModels[key] = nil
  }

  private func canonicalKey(_ fileURL: URL) -> String {
    fileURL.standardizedFileURL.path
  }
}
