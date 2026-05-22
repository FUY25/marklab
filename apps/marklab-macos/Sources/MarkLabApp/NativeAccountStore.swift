import Foundation
import MarkLabMacOS

struct NativeStoredAccount: Codable, Equatable, Sendable {
  let apiBaseURL: URL
  let webBaseURL: URL
  let token: String
  let userId: String
  let email: String
  let displayName: String
  let workspaceId: String
  let workspaceName: String

  var user: NativeAccountUser {
    NativeAccountUser(userId: userId, email: email, displayName: displayName)
  }

  var workspace: NativeWorkspaceSummary {
    NativeWorkspaceSummary(workspaceId: workspaceId, name: workspaceName, role: "Owner")
  }
}

final class NativeAccountStore: @unchecked Sendable {
  private let directoryURL: URL
  private let fileManager: FileManager

  init(directoryURL: URL, fileManager: FileManager = .default) {
    self.directoryURL = directoryURL
    self.fileManager = fileManager
  }

  static func defaultStore() -> NativeAccountStore {
    NativeAccountStore(directoryURL: NativeAppSupportDirectory.url().appending(path: "account", directoryHint: .isDirectory))
  }

  func load() throws -> NativeStoredAccount? {
    let url = accountURL
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(NativeStoredAccount.self, from: data)
  }

  func save(_ account: NativeStoredAccount) throws {
    try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(account)
    try data.write(to: accountURL, options: [.atomic, .completeFileProtection])
    try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: accountURL.path)
  }

  func clear() throws {
    let url = accountURL
    if fileManager.fileExists(atPath: url.path) {
      try fileManager.removeItem(at: url)
    }
  }

  private var accountURL: URL {
    directoryURL.appending(path: "account.json", directoryHint: .notDirectory)
  }
}

struct NativeHostedDefaults: Equatable, Sendable {
  let apiBaseURL: URL
  let webBaseURL: URL

  static let alpha = NativeHostedDefaults(
    apiBaseURL: URL(string: "https://marklab-relay-alpha.fly.dev")!,
    webBaseURL: URL(string: "https://marklab-relay-alpha.fly.dev")!
  )

  static func fromEnvironment() -> NativeHostedDefaults {
    let environment = ProcessInfo.processInfo.environment
    let apiURL = environment["MARKLAB_CONTROL_PLANE_API_URL"].flatMap(URL.init(string:)) ?? alpha.apiBaseURL
    let webURL = environment["MARKLAB_PUBLIC_WEB_URL"].flatMap(URL.init(string:)) ?? alpha.webBaseURL
    return NativeHostedDefaults(apiBaseURL: apiURL, webBaseURL: webURL)
  }
}

struct NativeAuthCallback: Equatable {
  let token: String
  let apiBaseURL: URL
  let webBaseURL: URL
  let user: NativeAccountUser

  static func parse(_ url: URL) -> NativeAuthCallback? {
    guard url.scheme == "marklab", url.host == "auth", url.path == "/callback" else { return nil }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    func item(_ name: String) -> String? {
      components.queryItems?.first(where: { $0.name == name })?.value
    }
    guard
      let token = item("token"),
      !token.isEmpty,
      let apiBaseURLString = item("apiBaseURL"),
      let apiBaseURL = URL(string: apiBaseURLString),
      let webBaseURLString = item("webBaseURL"),
      let webBaseURL = URL(string: webBaseURLString),
      let userId = item("userId"),
      !userId.isEmpty,
      let email = item("email"),
      let displayName = item("displayName"),
      !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      return nil
    }
    return NativeAuthCallback(
      token: token,
      apiBaseURL: apiBaseURL,
      webBaseURL: webBaseURL,
      user: NativeAccountUser(userId: userId, email: email, displayName: displayName)
    )
  }
}
