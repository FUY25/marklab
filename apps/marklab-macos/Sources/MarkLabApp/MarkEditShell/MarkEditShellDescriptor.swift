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

enum MarkEditShellWindowChrome: Equatable {
  case nativeDocumentToolbar
}

enum MarkEditShellWindowSizing: Equatable {
  case markEditDefaultDocument
}

enum MarkEditShellEditorSurfacePresentation: Equatable {
  case edgeToEdgeEditor
}

enum MarkEditShellStatusPresentation: Equatable {
  case floatingEditorStatusPill
}

enum MarkEditShellCollaborationInspectorBehavior: Equatable {
  case hiddenUntilToggledOrRequired
}

enum MarkEditShellCollaborationToolbarPlacement: Equatable {
  case nativeToolbarMenu
}

enum MarkEditShellFileCommandPlacement: Equatable {
  case nativeFileMenuKeyboardShortcut
}

enum MarkEditShellCollaborationSurfaceMode: Equatable {
  case localEditorForUnsharedFilesVisibleHostedEditorForSharedFiles
}

enum MarkEditShellCommand: Equatable {
  case open
  case save
  case startSharing
  case createEditLink
  case createViewLink
  case copyLink
  case revokeLink
}

struct MarkEditDocumentWindowMetrics: Equatable {
  let width: Double
  let height: Double

  static let markEditDefault = MarkEditDocumentWindowMetrics(width: 720, height: 480)
}

struct MarkEditShellDescriptor: Equatable {
  let documentMode: MarkEditShellDocumentMode
  let sourceAttribution: String
  let localEditorMode: MarkEditShellLocalEditorMode
  let collaborationLayerPlacement: MarkEditShellCollaborationLayerPlacement
  let windowChrome: MarkEditShellWindowChrome
  let windowSizing: MarkEditShellWindowSizing
  let editorSurfacePresentation: MarkEditShellEditorSurfacePresentation
  let statusPresentation: MarkEditShellStatusPresentation
  let collaborationInspectorBehavior: MarkEditShellCollaborationInspectorBehavior
  let collaborationToolbarPlacement: MarkEditShellCollaborationToolbarPlacement
  let preservesMarkEditFormattingToolbar: Bool
  let fileCommandPlacement: MarkEditShellFileCommandPlacement
  let collaborationSurfaceMode: MarkEditShellCollaborationSurfaceMode
  let defaultWindowMetrics: MarkEditDocumentWindowMetrics
  let prototypeRootOwnsEditorLayout: Bool
  let opensFilesInDocumentWindowController: Bool
  let collaborationCommands: [MarkEditShellCommand]

  static let current = MarkEditShellDescriptor(
    documentMode: .documentWindow,
    sourceAttribution: "Learning resources/MarkEdit/MarkEditMac/Sources/Editor",
    localEditorMode: .webkitCodeMirror,
    collaborationLayerPlacement: .toolbarStatusInspector,
    windowChrome: .nativeDocumentToolbar,
    windowSizing: .markEditDefaultDocument,
    editorSurfacePresentation: .edgeToEdgeEditor,
    statusPresentation: .floatingEditorStatusPill,
    collaborationInspectorBehavior: .hiddenUntilToggledOrRequired,
    collaborationToolbarPlacement: .nativeToolbarMenu,
    preservesMarkEditFormattingToolbar: true,
    fileCommandPlacement: .nativeFileMenuKeyboardShortcut,
    collaborationSurfaceMode: .localEditorForUnsharedFilesVisibleHostedEditorForSharedFiles,
    defaultWindowMetrics: .markEditDefault,
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
    ]
  )
}
