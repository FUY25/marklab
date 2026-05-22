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

final class RecordingHTTPTransport: NativeHTTPTransport, @unchecked Sendable {
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

func waitForRecordedRequests(
  _ transport: RecordingHTTPTransport,
  count: Int,
  timeoutNanoseconds: UInt64 = 1_000_000_000
) async throws {
  let step: UInt64 = 20_000_000
  var elapsed: UInt64 = 0
  while transport.requests.count < count && elapsed < timeoutNanoseconds {
    try await Task.sleep(nanoseconds: step)
    elapsed += step
  }
}

actor BlockingFirstHTTPTransport: NativeHTTPTransport {
  private var responses: [NativeHTTPResponse] = []
  private(set) var requests: [RecordedHTTPRequest] = []
  private var didStartFirstRequest = false
  private var firstStartedContinuation: CheckedContinuation<Void, Never>?
  private var firstReleaseContinuation: CheckedContinuation<Void, Never>?

  func enqueue(json: String, statusCode: Int = 200) {
    responses.append(NativeHTTPResponse(
      statusCode: statusCode,
      data: Data(json.utf8),
      headers: ["content-type": "application/json"]
    ))
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
    let shouldBlockFirstRequest = !didStartFirstRequest
    didStartFirstRequest = true
    if responses.isEmpty { throw NativeHTTPError.transport("missing test response") }
    let response = responses.removeFirst()

    if shouldBlockFirstRequest {
      await withCheckedContinuation { continuation in
        firstReleaseContinuation = continuation
        firstStartedContinuation?.resume()
        firstStartedContinuation = nil
      }
    }

    return response
  }

  func waitUntilFirstRequestStarted() async {
    if firstReleaseContinuation != nil {
      return
    }
    await withCheckedContinuation { continuation in
      firstStartedContinuation = continuation
    }
  }

  func releaseFirstRequest() {
    firstReleaseContinuation?.resume()
    firstReleaseContinuation = nil
  }
}

actor PathBlockingHTTPTransport: NativeHTTPTransport {
  struct QueuedResponse {
    let pathContains: String?
    let response: NativeHTTPResponse
    let blocks: Bool
  }

  private var responses: [QueuedResponse] = []
  private(set) var requests: [RecordedHTTPRequest] = []
  private var blockedContinuation: CheckedContinuation<Void, Never>?
  private var blockedStartedContinuation: CheckedContinuation<Void, Never>?

  func enqueue(json: String, statusCode: Int = 200, pathContains: String? = nil, blocks: Bool = false) {
    responses.append(QueuedResponse(
      pathContains: pathContains,
      response: NativeHTTPResponse(statusCode: statusCode, data: Data(json.utf8), headers: ["content-type": "application/json"]),
      blocks: blocks
    ))
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
    guard let index = responses.firstIndex(where: { queued in
      queued.pathContains.map { request.url.path.contains($0) } ?? true
    }) else {
      throw NativeHTTPError.transport("missing test response")
    }
    let queued = responses.remove(at: index)
    if queued.blocks {
      await withCheckedContinuation { continuation in
        blockedContinuation = continuation
        blockedStartedContinuation?.resume()
        blockedStartedContinuation = nil
      }
    }
    return queued.response
  }

  func waitUntilBlocked() async {
    if blockedContinuation != nil { return }
    await withCheckedContinuation { continuation in
      blockedStartedContinuation = continuation
    }
  }

  func releaseBlockedRequest() {
    blockedContinuation?.resume()
    blockedContinuation = nil
  }
}
