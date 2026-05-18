import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native hosted webview security")
struct NativeHostedWebViewSecurityTests {
  @Test("allows only the expected collab origin and route")
  func allowsOnlyExpectedCollabOriginAndRoute() throws {
    let expectedURL = try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&localDocId=local_1&nativeShell=markedit"))

    #expect(nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?clientKind=app&mode=edit&branchId=branch_1&docId=doc_1&localDocId=local_1&nativeShell=markedit")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?clientKind=app&mode=edit&branchId=branch_1&docId=doc_1&localDocId=local_1#localDaemonToken=local-secret&localApiUrl=http://127.0.0.1:3011")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://attacker.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/workspaces/ws_1/settings")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?docId=doc_other&branchId=branch_1&mode=edit&clientKind=app")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=other&mode=edit&clientKind=app")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&extra=1")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&localDocId=other")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&localDocId=local_1&nativeShell=other")),
      expectedURL: expectedURL
    ))
    #expect(!nativeHostedWebViewURLIsAllowed(
      try #require(URL(string: "https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit&clientKind=app&clientKind=app")),
      expectedURL: expectedURL
    ))
  }

  @Test("matches default HTTPS origin ports")
  func matchesDefaultHTTPSOriginPorts() throws {
    let origin = NativeHostedWebViewOrigin(url: try #require(URL(string: "https://app.example.test/collab")))

    #expect(origin.matches(scheme: "https", host: "app.example.test", port: 443))
    #expect(!origin.matches(scheme: "https", host: "app.example.test", port: 444))
  }
}
