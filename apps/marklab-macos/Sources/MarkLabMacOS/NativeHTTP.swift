import Foundation

public struct NativeHTTPRequest: Equatable, Sendable {
  public var method: String
  public var url: URL
  public var headers: [String: String]
  public var body: Data?

  public init(method: String, url: URL, headers: [String: String] = [:], body: Data? = nil) {
    self.method = method
    self.url = url
    self.headers = headers
    self.body = body
  }
}

public struct NativeHTTPResponse: Equatable, Sendable {
  public var statusCode: Int
  public var data: Data
  public var headers: [String: String]

  public init(statusCode: Int, data: Data, headers: [String: String]) {
    self.statusCode = statusCode
    self.data = data
    self.headers = headers
  }
}

public enum NativeHTTPError: Error, Equatable {
  case transport(String)
  case httpStatus(Int)
  case invalidJSON
}

public protocol NativeHTTPTransport: AnyObject {
  func send(_ request: NativeHTTPRequest) async throws -> NativeHTTPResponse
}

public final class URLSessionNativeHTTPTransport: NativeHTTPTransport {
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func send(_ request: NativeHTTPRequest) async throws -> NativeHTTPResponse {
    var urlRequest = URLRequest(url: request.url)
    urlRequest.httpMethod = request.method
    urlRequest.httpBody = request.body
    for (header, value) in request.headers {
      urlRequest.setValue(value, forHTTPHeaderField: header)
    }

    do {
      let (data, response) = try await session.data(for: urlRequest)
      guard let httpResponse = response as? HTTPURLResponse else {
        throw NativeHTTPError.transport("missing HTTPURLResponse")
      }
      var headers: [String: String] = [:]
      for (key, value) in httpResponse.allHeaderFields {
        headers[String(describing: key)] = String(describing: value)
      }
      return NativeHTTPResponse(statusCode: httpResponse.statusCode, data: data, headers: headers)
    } catch let error as NativeHTTPError {
      throw error
    } catch {
      throw NativeHTTPError.transport(error.localizedDescription)
    }
  }
}

func nativeJSONData<T: Encodable>(_ value: T) throws -> Data {
  let encoder = JSONEncoder()
  return try encoder.encode(value)
}

func decodeNativeJSON<T: Decodable>(_ type: T.Type, from response: NativeHTTPResponse) throws -> T {
  guard (200..<300).contains(response.statusCode) else {
    throw NativeHTTPError.httpStatus(response.statusCode)
  }
  if T.self == EmptyNativeResponse.self {
    return EmptyNativeResponse() as! T
  }
  do {
    return try JSONDecoder().decode(type, from: response.data)
  } catch {
    throw NativeHTTPError.invalidJSON
  }
}

struct EmptyNativeResponse: Decodable {}

func appendPath(_ path: String, to baseURL: URL) -> URL {
  var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
  let basePath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  let nextPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  components.percentEncodedPath = "/" + [basePath, nextPath].filter { !$0.isEmpty }.joined(separator: "/")
  return components.url!
}

func encodeNativePathSegment(_ value: String) -> String {
  let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
  return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}
