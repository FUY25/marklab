import Foundation
import AppKit
import SwiftUI
import WebKit

// Adapted from MarkEdit, MIT licensed.
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorWebView.swift
// Copyright (c) 2023 MarkEdit.app.

struct MarkEditLocalMarkdownEditorView: NSViewRepresentable {
  @Binding var text: String
  @Binding var selectionStatusText: String
  let isEditable: Bool
  let command: MarkEditLocalEditorCommand?

  func makeCoordinator() -> Coordinator {
    Coordinator(text: $text, selectionStatusText: $selectionStatusText)
  }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(context.coordinator, name: "marklabLocalEditor")
    let webView = MarkEditLocalEditorWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.setValue(false, forKey: "drawsBackground")
    context.coordinator.webView = webView
    context.coordinator.loadInitialDocument(in: webView, text: text, isEditable: isEditable)
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.update(webView: webView, text: text, isEditable: isEditable, command: command)
  }

  static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
    coordinator.webView = nil
    nsView.navigationDelegate = nil
    nsView.configuration.userContentController.removeScriptMessageHandler(forName: "marklabLocalEditor")
  }

  static func bundledEditorContract() throws -> MarkEditLocalEditorResourceContract {
    let htmlURL = try MarkEditLocalEditorResources.indexHTMLURL()
    let scriptURL = try MarkEditLocalEditorResources.scriptURL()
    let html = try String(contentsOf: htmlURL, encoding: .utf8)
    let script = try String(contentsOf: scriptURL, encoding: .utf8)
    return MarkEditLocalEditorResourceContract(
      htmlContainsCodeMirrorRoot: html.contains("id=\"editor\"") && !html.contains("<textarea"),
      htmlUsesClassicBundledScript: html.contains("<script src=\"./local-editor.js\"></script>") && !html.contains("type=\"module\""),
      scriptContainsCodeMirrorRuntime: script.contains("codemirror") || script.contains("marklabEditor=\"codemirror\""),
      scriptContainsNativeBridge: script.contains("__marklabSetMarkdown") && script.contains("markdown-change"),
      scriptContainsSelectionStatusBridge: script.contains("selection-change"),
      scriptPostsEditorReady: script.contains("editor-ready"),
      scriptContainsFormattingCommandBridge: script.contains("__marklabRunEditorCommand"),
      scriptContainsMarkEditMarkdownVisualTheme: script.contains("#0550ae")
        && script.contains("#1a7f37")
        && script.contains("19px")
        && script.contains("cm-lineNumbers")
    )
  }

  static func preferredLineSeparatorForTesting(_ text: String) -> String {
    Coordinator.preferredLineSeparator(for: text)
  }

  static func markdownFromBridgeForTesting(
    _ markdown: String,
    lineSeparator: String?,
    lineEndings: [String]? = nil
  ) -> String {
    Coordinator.markdownFromBridge(markdown, lineSeparator: lineSeparator, lineEndings: lineEndings)
  }

  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private var text: Binding<String>
    private var selectionStatusText: Binding<String>
    private var loaded = false
    private var editorReady = false
    private var lastRenderedText = ""
    private var lastEditable = true
    private var pendingText: String?
    private var pendingEditable: Bool?
    private var pendingCommand: MarkEditLocalEditorCommand?
    private var bridgeReadyPolls = 0
    private var lastAppliedCommandSequence = 0
    weak var webView: WKWebView?

    init(text: Binding<String>, selectionStatusText: Binding<String>) {
      self.text = text
      self.selectionStatusText = selectionStatusText
    }

    func loadInitialDocument(in webView: WKWebView, text: String, isEditable: Bool) {
      loaded = true
      editorReady = false
      bridgeReadyPolls = 0
      lastRenderedText = text
      lastEditable = isEditable
      guard
        let indexURL = try? MarkEditLocalEditorResources.indexHTMLURL(),
        let resourceRootURL = try? MarkEditLocalEditorResources.rootURL()
      else {
        return
      }
      pendingText = text
      pendingEditable = isEditable
      webView.loadFileURL(indexURL, allowingReadAccessTo: resourceRootURL)
    }

    func update(
      webView: WKWebView,
      text: String,
      isEditable: Bool,
      command: MarkEditLocalEditorCommand?
    ) {
      guard loaded else {
        loadInitialDocument(in: webView, text: text, isEditable: isEditable)
        return
      }
      if text != lastRenderedText {
        lastRenderedText = text
        applyOrQueue(
          webView: webView,
          javascript: "window.__marklabSetMarkdown(\(Self.javascriptString(text)), \(Self.javascriptString(Self.preferredLineSeparator(for: text))));",
          pending: { pendingText = text }
        )
      }
      if isEditable != lastEditable {
        lastEditable = isEditable
        applyOrQueue(
          webView: webView,
          javascript: "window.__marklabSetEditable(\(isEditable ? "true" : "false"));",
          pending: { pendingEditable = isEditable }
        )
      }
      if let command, command.sequence != lastAppliedCommandSequence {
        applyEditorCommand(command, in: webView)
      }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      bridgeReadyPolls = 0
      waitForEditorBridge(in: webView)
    }

    private func markEditorReady(in webView: WKWebView) {
      guard !editorReady else { return }
      editorReady = true
      if let pendingText {
        webView.evaluateJavaScript("window.__marklabSetMarkdown(\(Self.javascriptString(pendingText)), \(Self.javascriptString(Self.preferredLineSeparator(for: pendingText))));")
        self.pendingText = nil
      }
      if let pendingEditable {
        webView.evaluateJavaScript("window.__marklabSetEditable(\(pendingEditable ? "true" : "false"));")
        self.pendingEditable = nil
      }
      if let pendingCommand {
        applyEditorCommand(pendingCommand, in: webView)
        self.pendingCommand = nil
      }
    }

    private func waitForEditorBridge(in webView: WKWebView) {
      webView.evaluateJavaScript("typeof window.__marklabSetMarkdown === 'function' && typeof window.__marklabSetEditable === 'function' && typeof window.__marklabRunEditorCommand === 'function'") { [weak self, weak webView] result, _ in
        guard let self, let webView else { return }
        if result as? Bool == true {
          self.markEditorReady(in: webView)
          return
        }
        guard self.bridgeReadyPolls < 20 else { return }
        self.bridgeReadyPolls += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak webView] in
          guard let self, let webView else { return }
          self.waitForEditorBridge(in: webView)
        }
      }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard
        message.name == "marklabLocalEditor",
        let body = message.body as? [String: Any],
        let type = body["type"] as? String
      else {
        return
      }
      if type == "editor-ready", let webView {
        markEditorReady(in: webView)
        return
      }
      if type == "selection-change", let status = body["status"] as? String {
        selectionStatusText.wrappedValue = status
        return
      }
      guard
        type == "markdown-change",
        let markdown = body["markdown"] as? String
      else {
        return
      }
      let bridgedMarkdown = Self.markdownFromBridge(
        markdown,
        lineSeparator: body["lineSeparator"] as? String,
        lineEndings: body["lineEndings"] as? [String]
      )
      lastRenderedText = bridgedMarkdown
      text.wrappedValue = bridgedMarkdown
    }

    private func applyOrQueue(webView: WKWebView, javascript: String, pending: () -> Void) {
      guard editorReady else {
        pending()
        return
      }
      webView.evaluateJavaScript(javascript)
    }

    private func applyEditorCommand(_ command: MarkEditLocalEditorCommand, in webView: WKWebView) {
      lastAppliedCommandSequence = command.sequence
      let javascript = "window.__marklabRunEditorCommand(\(command.action.javascriptPayload));"
      applyOrQueue(
        webView: webView,
        javascript: javascript,
        pending: { pendingCommand = command }
      )
    }

    fileprivate static func preferredLineSeparator(for text: String) -> String {
      let endings = lineEndings(for: text)
      guard let firstEnding = endings.first else { return "\n" }
      let counts = endings.reduce(into: [String: Int]()) { partialResult, ending in
        partialResult[ending, default: 0] += 1
      }
      return endings.reduce(firstEnding) { best, ending in
        (counts[ending] ?? 0) > (counts[best] ?? 0) ? ending : best
      }
    }

    fileprivate static func markdownFromBridge(
      _ markdown: String,
      lineSeparator: String?,
      lineEndings: [String]?
    ) -> String {
      if let lineEndings, !lineEndings.isEmpty {
        return applyLineEndings(markdown, lineEndings: lineEndings, fallback: sanitizedLineSeparator(lineSeparator))
      }
      guard let lineSeparator = sanitizedLineSeparator(lineSeparator) else { return markdown }
      return applyLineEndings(markdown, lineEndings: [], fallback: lineSeparator)
    }

    private static func lineEndings(for text: String) -> [String] {
      var endings: [String] = []
      let bytes = Array(text.utf8)
      var index = 0
      while index < bytes.count {
        if bytes[index] == 13 {
          if index + 1 < bytes.count, bytes[index + 1] == 10 {
            endings.append("\r\n")
            index += 2
          } else {
            endings.append("\r")
            index += 1
          }
        } else if bytes[index] == 10 {
          endings.append("\n")
          index += 1
        } else {
          index += 1
        }
      }
      return endings
    }

    private static func sanitizedLineSeparator(_ lineSeparator: String?) -> String? {
      guard let lineSeparator, ["\r\n", "\r", "\n"].contains(lineSeparator) else { return nil }
      return lineSeparator
    }

    private static func applyLineEndings(
      _ markdown: String,
      lineEndings: [String],
      fallback: String?
    ) -> String {
      let normalized = markdown
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
      let fallback = fallback ?? "\n"
      let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
      guard lines.count > 1 else { return normalized }
      var result = ""
      for index in lines.indices {
        result += lines[index]
        if index < lines.index(before: lines.endIndex) {
          let endingIndex = lines.distance(from: lines.startIndex, to: index)
          result += lineEndings.indices.contains(endingIndex) ? lineEndings[endingIndex] : fallback
        }
      }
      return result
    }

    private static func javascriptString(_ value: String) -> String {
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
  }
}

struct MarkEditLocalEditorCommand: Equatable {
  let sequence: Int
  let action: MarkEditLocalEditorCommandAction
}

enum MarkEditLocalEditorCommandAction: Equatable {
  case gotoLine(Int)
  case heading(Int)
  case bold
  case italic
  case unorderedList
  case orderedList
  case taskList

  var javascriptPayload: String {
    switch self {
    case let .gotoLine(line):
      return #"{"type":"gotoLine","line":\#(max(1, line))}"#
    case let .heading(level):
      return #"{"type":"heading","level":\#(min(6, max(1, level)))}"#
    case .bold:
      return #"{"type":"bold"}"#
    case .italic:
      return #"{"type":"italic"}"#
    case .unorderedList:
      return #"{"type":"unorderedList"}"#
    case .orderedList:
      return #"{"type":"orderedList"}"#
    case .taskList:
      return #"{"type":"taskList"}"#
    }
  }
}

struct MarkEditLocalEditorResourceContract: Equatable {
  let htmlContainsCodeMirrorRoot: Bool
  let htmlUsesClassicBundledScript: Bool
  let scriptContainsCodeMirrorRuntime: Bool
  let scriptContainsNativeBridge: Bool
  let scriptContainsSelectionStatusBridge: Bool
  let scriptPostsEditorReady: Bool
  let scriptContainsFormattingCommandBridge: Bool
  let scriptContainsMarkEditMarkdownVisualTheme: Bool
}

private enum MarkEditLocalEditorResources {
  private static let resourceBundleName = "MarkLabMacOS_MarkLabApp.bundle"

  static func rootURL() throws -> URL {
    let fileManager = FileManager.default
    let candidates = [
      Bundle.main.resourceURL?.appending(path: resourceBundleName, directoryHint: .isDirectory),
      Bundle.main.bundleURL.appending(path: resourceBundleName, directoryHint: .isDirectory),
      Bundle.module.resourceURL,
    ].compactMap { $0 }
    if let resourceURL = candidates.first(where: { fileManager.fileExists(atPath: $0.path) }) {
      return resourceURL
    }
    throw MarkEditLocalEditorResourceError.missingRoot
  }

  static func indexHTMLURL() throws -> URL {
    let url = try rootURL().appending(path: "index.html", directoryHint: .notDirectory)
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw MarkEditLocalEditorResourceError.missingIndexHTML
    }
    return url
  }

  static func scriptURL() throws -> URL {
    let url = try rootURL().appending(path: "local-editor.js", directoryHint: .notDirectory)
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw MarkEditLocalEditorResourceError.missingScript
    }
    return url
  }
}

private enum MarkEditLocalEditorResourceError: Error {
  case missingRoot
  case missingIndexHTML
  case missingScript
}

private enum MarkEditWebViewMenuTag: Int {
  case downloadImage = 5
  case reload = 12
  case showFonts = 41
  case defaultDirection = 52
  case textDirectionDefault = 59
  case copyLinkWithHighlight = 102
}

private final class MarkEditLocalEditorWebView: WKWebView {
  override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
    menu.items = menu.items.filter { item in
      if item.tag == MarkEditWebViewMenuTag.downloadImage.rawValue { return false }
      if item.tag == MarkEditWebViewMenuTag.reload.rawValue { return false }
      if item.tag == MarkEditWebViewMenuTag.copyLinkWithHighlight.rawValue { return false }
      if item.submenuContains(anyOf: .showFonts, .defaultDirection, .textDirectionDefault) { return false }
      return true
    }
    super.willOpenMenu(menu, with: event)
  }

  override func accessibilityRole() -> NSAccessibility.Role? {
    .textArea
  }
}

private extension NSMenuItem {
  func submenuContains(anyOf tags: MarkEditWebViewMenuTag...) -> Bool {
    guard let submenu else { return false }
    return submenu.items.contains { item in
      tags.contains { tag in item.tag == tag.rawValue }
    }
  }
}
