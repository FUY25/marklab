import Foundation
import Testing
@testable import MarkLabMacOS

@Suite("Native daemon registry")
struct NativeDaemonRegistryTests {
  @Test("writes app-owned daemon entries in the same registry shape the CLI reads")
  func writesAppOwnedDaemonEntry() async throws {
    let directory = try TemporaryDirectory()
    let registryURL = directory.url.appending(path: "local-daemons.json")
    let entry = NativeDaemonRegistryEntry(
      realpath: "/tmp/note.md",
      pid: 42,
      apiPort: 3011,
      webPort: 5175,
      apiUrl: URL(string: "http://127.0.0.1:3011")!,
      webUrl: URL(string: "http://127.0.0.1:5175")!,
      localUrl: URL(string: "marklab://open/note.md")!,
      token: "local-token",
      ownerKind: .app
    )
    let registry = NativeDaemonRegistry(fileURL: registryURL)

    try registry.write(entries: [entry])
    let decoded = try registry.read()

    #expect(decoded.schemaVersion == 1)
    #expect(decoded.daemons.count == 1)
    #expect(decoded.daemons[0].schemaVersion == 1)
    #expect(decoded.daemons[0].displayName == "note.md")
    #expect(decoded.daemons[0].ownerKind == .app)
    #expect(decoded.daemons[0].apiUrl.absoluteString == "http://127.0.0.1:3011")
    let attributes = try FileManager.default.attributesOfItem(atPath: registryURL.path)
    #expect(attributes[.posixPermissions] as? Int == 0o600)
  }

  @Test("refuses to write while the CLI registry lock exists")
  func refusesWriteWhenLocked() throws {
    let directory = try TemporaryDirectory()
    let registryURL = directory.url.appending(path: "local-daemons.json")
    let lockURL = URL(fileURLWithPath: "\(registryURL.path).lock")
    FileManager.default.createFile(atPath: lockURL.path, contents: Data(), attributes: [.posixPermissions: 0o600])
    let registry = NativeDaemonRegistry(fileURL: registryURL)

    #expect(throws: NativeDaemonRegistryError.lockUnavailable) {
      try registry.write(entries: [])
    }
  }
}
