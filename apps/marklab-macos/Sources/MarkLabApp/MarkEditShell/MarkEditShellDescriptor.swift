import Foundation

// Adapted from MarkEdit, MIT licensed.
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Models/EditorDocument.swift
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/EditorWindowController.swift
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorWebView.swift
// Copyright (c) 2023 MarkEdit.app.

enum MarkEditShellDocumentMode: Equatable {
  case documentWindow
}

enum MarkEditShellLocalEditorMode: Equatable {
  case webkitCodeMirror
}

enum MarkEditShellCollaborationLayerPlacement: Equatable {
  case toolbarStatusInspector
}

enum MarkEditShellCommand: Equatable {
  case open
  case save
  case startSharing
  case createEditLink
  case createViewLink
  case copyLink
  case revokeLink
  case restoreLatestVersion
}

struct MarkEditShellDescriptor: Equatable {
  let documentMode: MarkEditShellDocumentMode
  let sourceAttribution: String
  let localEditorMode: MarkEditShellLocalEditorMode
  let collaborationLayerPlacement: MarkEditShellCollaborationLayerPlacement
  let prototypeRootOwnsEditorLayout: Bool
  let opensFilesInDocumentWindowController: Bool
  let collaborationCommands: [MarkEditShellCommand]

  static let current = MarkEditShellDescriptor(
    documentMode: .documentWindow,
    sourceAttribution: "Learning resources/MarkEdit/MarkEditMac/Sources/Editor",
    localEditorMode: .webkitCodeMirror,
    collaborationLayerPlacement: .toolbarStatusInspector,
    prototypeRootOwnsEditorLayout: false,
    opensFilesInDocumentWindowController: true,
    collaborationCommands: [
      .open,
      .save,
      .startSharing,
      .createEditLink,
      .createViewLink,
      .copyLink,
      .revokeLink,
      .restoreLatestVersion,
    ]
  )
}
