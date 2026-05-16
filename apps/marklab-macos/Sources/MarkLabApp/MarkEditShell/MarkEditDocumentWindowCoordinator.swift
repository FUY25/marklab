import AppKit
import SwiftUI

// Adapted from MarkEdit, MIT licensed.
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/EditorWindowController.swift
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/EditorWindow.swift
// Copyright (c) 2023 MarkEdit.app.

@MainActor
final class MarkEditDocumentWindowCoordinator {
  static let shared = MarkEditDocumentWindowCoordinator()

  private var controllers: [ObjectIdentifier: MarkEditDocumentWindowController] = [:]

  @discardableResult
  func openDocumentWindow(fileURL: URL) -> MarkEditDocumentWindowOpenResult {
    let model = MarkLabAppModel(opensSelectedFilesInNewDocumentWindow: false)
    model.loadFile(fileURL)
    guard model.filePath != nil else { return .failed(statusText: model.statusText) }
    let controller = MarkEditDocumentWindowController(model: model) { [weak self] controller in
      self?.controllers[ObjectIdentifier(controller)] = nil
    }
    controllers[ObjectIdentifier(controller)] = controller
    controller.showWindow(nil)
    NSApp.activate(ignoringOtherApps: true)
    return .opened
  }
}

enum MarkEditDocumentWindowOpenResult: Equatable {
  case opened
  case failed(statusText: String)
}

@MainActor
private final class MarkEditDocumentWindowController: NSWindowController, NSWindowDelegate {
  private let onClose: (MarkEditDocumentWindowController) -> Void

  init(model: MarkLabAppModel, onClose: @escaping (MarkEditDocumentWindowController) -> Void) {
    self.onClose = onClose
    let rootView = MarkEditDocumentShellView(model: model)
    let hostingController = NSHostingController(rootView: rootView)
    let window = NSWindow(contentViewController: hostingController)
    window.title = model.filePath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "MarkLab"
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.backgroundColor = .controlBackgroundColor
    window.setContentSize(NSSize(width: 1060, height: 720))
    window.minSize = NSSize(width: 840, height: 560)
    super.init(window: window)
    window.delegate = self
    windowFrameAutosaveName = "MarkEditDocument"
    shouldCascadeWindows = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func windowWillClose(_ notification: Notification) {
    onClose(self)
  }
}
