import Foundation

public enum NativeAppSupportDirectory {
  public static func url(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    fileManager: FileManager = .default
  ) -> URL {
    if let override = environment["MARKLAB_APP_SUPPORT_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
       !override.isEmpty {
      return URL(fileURLWithPath: override)
    }
    let baseURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? fileManager.temporaryDirectory
    return baseURL.appending(path: "MarkLab", directoryHint: .isDirectory)
  }
}
