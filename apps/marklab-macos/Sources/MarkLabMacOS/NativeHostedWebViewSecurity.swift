import Foundation

public struct NativeHostedWebViewOrigin: Equatable {
  public let scheme: String
  public let host: String
  public let port: Int

  public init(url: URL) {
    self.scheme = url.scheme ?? ""
    self.host = url.host ?? ""
    self.port = url.port ?? NativeHostedWebViewOrigin.defaultPort(for: scheme)
  }

  public static func defaultPort(for scheme: String) -> Int {
    switch scheme.lowercased() {
    case "https":
      return 443
    case "http":
      return 80
    default:
      return 0
    }
  }

  public func matches(scheme: String, host: String, port: Int) -> Bool {
    self.scheme.lowercased() == scheme.lowercased()
      && self.host.lowercased() == host.lowercased()
      && self.port == port
  }
}

public func nativeHostedWebViewURLIsAllowed(_ url: URL, expectedURL: URL) -> Bool {
  let actual = NativeHostedWebViewOrigin(url: url)
  let expected = NativeHostedWebViewOrigin(url: expectedURL)
  guard actual == expected, url.path == "/collab", expectedURL.path == "/collab" else { return false }
  guard
    let actualQuery = nativeHostedWebViewQueryValues(url),
    let expectedQuery = nativeHostedWebViewQueryValues(expectedURL)
  else {
    return false
  }
  return actualQuery == expectedQuery
}

private func nativeHostedWebViewQueryValues(_ url: URL) -> [String: String]? {
  let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
  let allowedKeys = Set(["docId", "branchId", "token", "mode", "clientKind"])
  var seen = Set<String>()
  var values: [String: String] = [:]
  for item in queryItems {
    guard allowedKeys.contains(item.name), !seen.contains(item.name) else { return nil }
    seen.insert(item.name)
    values[item.name] = item.value ?? ""
  }
  guard !values.isEmpty else { return nil }
  return values
}
