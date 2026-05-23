import Foundation
import MarkLabMacOS
import Security

extension Notification.Name {
  static let markLabAccountDidSignOut = Notification.Name("MarkLabAccountDidSignOut")
  static let markLabAccountDidSignIn = Notification.Name("MarkLabAccountDidSignIn")
}

enum NativeAccountSignOutNotification {
  static let tokenKey = "token"
}

enum NativeAccountSignInNotification {
  static let tokenKey = "token"
}

enum NativeAuthPendingState {
  static func generate() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    let byteCount = bytes.count
    let status = bytes.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, byteCount, buffer.baseAddress!)
    }
    guard status == errSecSuccess else {
      return UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

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
    for url in [accountURL, pendingAuthStateURL] where fileManager.fileExists(atPath: url.path) {
      try fileManager.removeItem(at: url)
    }
  }

  func loadPendingAuthState() throws -> String? {
    let url = pendingAuthStateURL
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    return try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func savePendingAuthState(_ state: String) throws {
    try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    try Data(state.utf8).write(to: pendingAuthStateURL, options: [.atomic, .completeFileProtection])
    try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pendingAuthStateURL.path)
  }

  func clearPendingAuthState() throws {
    let url = pendingAuthStateURL
    if fileManager.fileExists(atPath: url.path) {
      try fileManager.removeItem(at: url)
    }
  }

  private var accountURL: URL {
    directoryURL.appending(path: "account.json", directoryHint: .notDirectory)
  }

  private var pendingAuthStateURL: URL {
    directoryURL.appending(path: "pending-auth-state", directoryHint: .notDirectory)
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

  func allows(apiBaseURL candidateApiBaseURL: URL, webBaseURL candidateWebBaseURL: URL) -> Bool {
    Self.sameOrigin(apiBaseURL, candidateApiBaseURL) && Self.sameOrigin(webBaseURL, candidateWebBaseURL)
  }

  private static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
    guard
      let leftComponents = URLComponents(url: left, resolvingAgainstBaseURL: false),
      let rightComponents = URLComponents(url: right, resolvingAgainstBaseURL: false)
    else {
      return false
    }
    return leftComponents.scheme?.lowercased() == rightComponents.scheme?.lowercased()
      && leftComponents.host?.lowercased() == rightComponents.host?.lowercased()
      && (leftComponents.port ?? defaultPort(for: leftComponents.scheme)) == (rightComponents.port ?? defaultPort(for: rightComponents.scheme))
  }

  private static func defaultPort(for scheme: String?) -> Int? {
    switch scheme?.lowercased() {
    case "http":
      return 80
    case "https":
      return 443
    default:
      return nil
    }
  }
}

struct NativeAuthCallback: Equatable {
  let token: String
  let appState: String
  let apiBaseURL: URL
  let webBaseURL: URL
  let user: NativeAccountUser

  static func parse(_ url: URL, hostedDefaults: NativeHostedDefaults) -> NativeAuthCallback? {
    guard url.scheme == "marklab", url.host == "auth", url.path == "/callback" else { return nil }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    func item(_ name: String) -> String? {
      components.queryItems?.first(where: { $0.name == name })?.value
    }
    guard
      let token = item("token"),
      !token.isEmpty,
      let appState = item("appState"),
      !appState.isEmpty,
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
    guard hostedDefaults.allows(apiBaseURL: apiBaseURL, webBaseURL: webBaseURL) else { return nil }
    return NativeAuthCallback(
      token: token,
      appState: appState,
      apiBaseURL: apiBaseURL,
      webBaseURL: webBaseURL,
      user: NativeAccountUser(userId: userId, email: email, displayName: displayName)
    )
  }
}
