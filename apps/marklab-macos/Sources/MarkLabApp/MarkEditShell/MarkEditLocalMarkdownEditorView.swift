import Foundation
import AppKit
import SwiftUI
import WebKit

// Adapted from MarkEdit, MIT licensed.
// Source: Learning resources/MarkEdit/MarkEditMac/Sources/Editor/Views/EditorWebView.swift
// Copyright (c) 2023 MarkEdit.app.

struct MarkEditLocalMarkdownEditorView: NSViewRepresentable {
  @Binding var text: String
  let isEditable: Bool

  func makeCoordinator() -> Coordinator {
    Coordinator(text: $text)
  }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(context.coordinator, name: "marklabLocalEditor")
    let webView = MarkEditLocalEditorWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.setValue(false, forKey: "drawsBackground")
    context.coordinator.loadInitialDocument(in: webView, text: text, isEditable: isEditable)
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.update(webView: webView, text: text, isEditable: isEditable)
  }

  static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
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
      scriptContainsCodeMirrorRuntime: script.contains("codemirror") || script.contains("marklabEditor=\"codemirror\""),
      scriptContainsNativeBridge: script.contains("__marklabSetMarkdown") && script.contains("markdown-change")
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
    private var loaded = false
    private var documentReady = false
    private var lastRenderedText = ""
    private var lastEditable = true
    private var pendingText: String?
    private var pendingEditable: Bool?

    init(text: Binding<String>) {
      self.text = text
    }

    func loadInitialDocument(in webView: WKWebView, text: String, isEditable: Bool) {
      loaded = true
      documentReady = false
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

    func update(webView: WKWebView, text: String, isEditable: Bool) {
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
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      documentReady = true
      if let pendingText {
        webView.evaluateJavaScript("window.__marklabSetMarkdown(\(Self.javascriptString(pendingText)), \(Self.javascriptString(Self.preferredLineSeparator(for: pendingText))));")
        self.pendingText = nil
      }
      if let pendingEditable {
        webView.evaluateJavaScript("window.__marklabSetEditable(\(pendingEditable ? "true" : "false"));")
        self.pendingEditable = nil
      }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard
        message.name == "marklabLocalEditor",
        let body = message.body as? [String: Any],
        body["type"] as? String == "markdown-change",
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
      guard documentReady else {
        pending()
        return
      }
      webView.evaluateJavaScript(javascript)
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

struct MarkEditLocalEditorResourceContract: Equatable {
  let htmlContainsCodeMirrorRoot: Bool
  let scriptContainsCodeMirrorRuntime: Bool
  let scriptContainsNativeBridge: Bool
}

private enum MarkEditLocalEditorResources {
  static func rootURL() throws -> URL {
    guard let resourceURL = Bundle.module.resourceURL else {
      throw MarkEditLocalEditorResourceError.missingRoot
    }
    return resourceURL
  }

  static func indexHTMLURL() throws -> URL {
    guard let url = Bundle.module.url(forResource: "index", withExtension: "html") else {
      throw MarkEditLocalEditorResourceError.missingIndexHTML
    }
    return url
  }

  static func scriptURL() throws -> URL {
    guard let url = Bundle.module.url(forResource: "local-editor", withExtension: "js") else {
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
