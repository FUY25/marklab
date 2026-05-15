import Foundation
@testable import MarkLabMacOS

struct TemporaryDirectory {
  let url: URL

  init() throws {
    url = FileManager.default.temporaryDirectory
      .appending(path: "marklab-macos-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }
}

struct RecordedHTTPRequest {
  let method: String
  let path: String
  let percentEncodedPath: String
  let authorization: String?
  let nativeAppProof: String?
  let bodyString: String

  var jsonBody: [String: Any]? {
    guard let data = bodyString.data(using: .utf8), !data.isEmpty else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}

final class RecordingHTTPTransport: NativeHTTPTransport {
  private var responses: [NativeHTTPResponse] = []
  private(set) var requests: [RecordedHTTPRequest] = []

  func enqueue(json: String, statusCode: Int = 200) {
    responses.append(NativeHTTPResponse(
      statusCode: statusCode,
      data: Data(json.utf8),
      headers: ["content-type": "application/json"]
    ))
  }

  func enqueue(data: Data, statusCode: Int) {
    responses.append(NativeHTTPResponse(statusCode: statusCode, data: data, headers: [:]))
  }

  func send(_ request: NativeHTTPRequest) async throws -> NativeHTTPResponse {
    requests.append(RecordedHTTPRequest(
      method: request.method,
      path: request.url.path,
      percentEncodedPath: URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? request.url.path,
      authorization: request.headers["Authorization"],
      nativeAppProof: request.headers["X-MarkLab-Native-App"],
      bodyString: request.body.map { String(decoding: $0, as: UTF8.self) } ?? ""
    ))
    if responses.isEmpty { throw NativeHTTPError.transport("missing test response") }
    return responses.removeFirst()
  }
}
