import Foundation
import MarkLabMacOS

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
