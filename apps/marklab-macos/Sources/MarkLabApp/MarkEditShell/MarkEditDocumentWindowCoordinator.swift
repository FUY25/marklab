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
    MarkLabBackgroundSharedDocumentHost.shared.release(fileURL: fileURL)
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
  private let model: MarkLabAppModel

  init(model: MarkLabAppModel, onClose: @escaping (MarkEditDocumentWindowController) -> Void) {
    self.onClose = onClose
    self.model = model
    let rootView = MarkEditDocumentShellView(model: model, retainsSharedDocumentOnDisappear: false)
    let hostingController = NSHostingController(rootView: rootView)
    let window = NSWindow(contentViewController: hostingController)
    window.title = model.filePath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "MarkLab"
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.toolbarStyle = .unified
    window.backgroundColor = .textBackgroundColor
    MarkEditDocumentWindowSizer.configureInitialFrame(for: window, display: false)
    super.init(window: window)
    window.delegate = self
    windowFrameAutosaveName = MarkEditDocumentWindowSizer.autosaveName
    shouldCascadeWindows = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func windowWillClose(_ notification: Notification) {
    if model.hasSharedDocument, let fileURL = model.fileURLForBackgroundRetention {
      MarkLabBackgroundSharedDocumentHost.shared.retain(model, fileURL: fileURL)
    }
    model.detachSharedWindow()
    onClose(self)
  }

  func windowDidResize(_ notification: Notification) {
    window?.saveFrame(usingName: MarkEditDocumentWindowSizer.autosaveName)
  }
}

@MainActor
enum MarkEditDocumentWindowSizer {
  static let autosaveName = "MarkEditDocument"

  static func configureInitialFrame(for window: NSWindow, display: Bool = true) {
    let metrics = MarkEditShellDescriptor.current.defaultWindowMetrics
    window.toolbarStyle = .unified
    window.titleVisibility = .visible
    window.titlebarAppearsTransparent = false
    window.backgroundColor = .textBackgroundColor
    window.setFrameAutosaveName(autosaveName)
    window.minSize = NSSize(width: 360, height: 260)
    guard !window.setFrameUsingName(autosaveName) else { return }
    let currentFrame = window.frame
    let frame = NSRect(
      x: currentFrame.minX,
      y: currentFrame.maxY - metrics.height,
      width: metrics.width,
      height: metrics.height
    )
    window.setFrame(frame, display: display)
  }
}
