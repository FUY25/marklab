import CryptoKit
import Foundation

public enum NativeLocalDocumentIdentity {
  public static func canonicalPath(fileURL: URL) -> String {
    fileURL.resolvingSymlinksInPath().standardizedFileURL.path
  }

  public static func localDocId(fileURL: URL) -> String {
    let path = canonicalPath(fileURL: fileURL)
    let digest = SHA256.hash(data: Data(path.utf8))
    return digest.map { String(format: "%02x", $0) }.joined().prefix(16).description
  }
}
