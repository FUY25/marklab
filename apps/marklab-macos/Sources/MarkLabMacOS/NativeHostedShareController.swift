import Foundation

public enum NativeHostedShareError: Error, Equatable {
  case documentNotShared
}

public final class NativeHostedShareController: @unchecked Sendable {
  private let client: NativeControlPlaneShareClient
  private var document: NativeHostedDocument?
  private var localDocId: String?
  private var suggestedFilename: String?

  public init(client: NativeControlPlaneShareClient) {
    self.client = client
  }

  public func startSharing(fileURL: URL) async throws -> NativeHostedDocument {
    let localDocument = try LocalMarkdownDocument.open(fileURL: fileURL, shared: true)
    let imported = try await client.importMarkdown(fileURL: fileURL, markdown: localDocument.markdownForSave())
    document = imported
    localDocId = NativeLocalDocumentIdentity.localDocId(fileURL: fileURL)
    suggestedFilename = fileURL.lastPathComponent
    return imported
  }

  public func restoreSharedDocument(from binding: NativeSharedDocumentBinding, suggestedFilename: String? = nil) {
    document = NativeHostedDocument(
      docId: binding.docId,
      branchId: binding.branchId,
      versionId: "",
      hash: binding.baselineHash
    )
    localDocId = binding.localDocId
    self.suggestedFilename = suggestedFilename ?? URL(fileURLWithPath: binding.filePath).lastPathComponent
  }

  public func createLink(role: NativeLinkRole) async throws -> NativeHostedShareLink {
    guard let document else { throw NativeHostedShareError.documentNotShared }
    return try await client.createAccessGrant(
      document: document,
      role: role,
      suggestedFilename: suggestedFilename
    )
  }

  public func appEditorURL() throws -> URL {
    guard let document else { throw NativeHostedShareError.documentNotShared }
    return client.appEditorURL(
      document: document,
      localDocId: localDocId
    )
  }

  public func revokeLink(grantId: String) async throws {
    try await client.revokeAccessGrant(grantId: grantId)
  }

  public func listLinks() async throws -> [NativeHostedAccessGrantSummary] {
    guard let document else { throw NativeHostedShareError.documentNotShared }
    return try await client.listAccessGrants(document: document)
  }
}
