import Foundation

public final class NativeShareController: @unchecked Sendable {
  private let daemonClient: NativeDaemonClient

  public init(daemonClient: NativeDaemonClient) {
    self.daemonClient = daemonClient
  }

  public func loadContext() async throws -> NativeAppContext {
    try await daemonClient.appContext()
  }

  public func startSharing() async throws -> NativeShareState {
    try await daemonClient.startSharing()
  }

  public func listVersions() async throws -> [NativeLocalVersionSummary] {
    try await daemonClient.listVersions()
  }

  public func restoreVersion(versionId: String) async throws -> NativeRestoreVersionResult {
    try await daemonClient.restoreVersion(versionId: versionId)
  }

  public func createEditLink() async throws -> NativeShareLink {
    try await daemonClient.createLink(role: .edit)
  }

  public func createViewLink() async throws -> NativeShareLink {
    try await daemonClient.createLink(role: .view)
  }

  public func revokeLink(grantId: String) async throws {
    try await daemonClient.revokeLink(grantId: grantId)
  }

  public func browserLinkString(for link: NativeShareLink) -> String {
    link.url.absoluteString
  }
}
