import Foundation
import WebKit

/// Serves the baked web bundle's same-origin API contract: requests under
/// `/v1/` are forwarded over URLSession to the environment's control-plane
/// base — the stamped `cloudUrl` (a tunnel URL, the app server's loopback
/// port, or the cloud web origin) — and every other request is handed to
/// Capacitor's stock asset handler.
///
/// Every other Cadet surface keeps this contract one way or another: the
/// web dev server proxies `/v1`, the desktop shell's `app://` protocol
/// handler forwards it, the edge and cloud takeovers route it. The mobile
/// webview's own origin serves only baked assets — the SPA fallback would
/// answer a same-origin `/v1` fetch with index markup — so this handler is
/// the mobile shell's half of the contract.
///
/// Session state rides `HTTPCookieStorage.shared`, the store Capacitor's
/// bridge already configures (`cookieAcceptPolicy = .always`): forwarded
/// responses' `Set-Cookie` headers land there, and later forwards attach
/// the matching cookies for the target origin automatically. The scheme
/// task has no cookie jar of its own, so the web layer must not expect
/// `document.cookie` to see API session cookies — its fetches carry
/// `credentials: "include"`, and this handler owns the jar.
final class SameOriginAPIHandler: NSObject, WKURLSchemeHandler {
    private let wrapped: WKURLSchemeHandler
    private let base: URL?
    private let session: URLSession

    /// Live routing per accepted task, keyed by identity — `WKURLSchemeTask`
    /// is a protocol, so the identity is the only stable handle, and WebKit
    /// hands the same task object back to `stop`.
    private enum Route {
        case forwarded(URLSessionDataTask)
        case assets
    }
    private var routes: [ObjectIdentifier: Route] = [:]

    init(wrapping: WKURLSchemeHandler, base: URL?, session: URLSession = .shared) {
        self.wrapped = wrapping
        self.base = base
        self.session = session
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              let base,
              url.path.hasPrefix("/v1"),
              let request = Self.forwardedRequest(for: task.request, to: base)
        else {
            routes[ObjectIdentifier(task)] = .assets
            wrapped.webView(webView, start: task)
            return
        }
        let key = ObjectIdentifier(task)
        let dataTask = session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                self?.settle(task, key: key, data: data, response: response, error: error)
            }
        }
        routes[key] = .forwarded(dataTask)
        dataTask.resume()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        // Dropping the route first turns the in-flight completion into a
        // no-op: a task WebKit stopped may not be told anything further.
        switch routes.removeValue(forKey: key) {
        case .forwarded(let dataTask):
            dataTask.cancel()
        case .assets:
            wrapped.webView(webView, stop: task)
        case nil:
            break
        }
    }

    /// Respond on the main thread, exactly once — after a `stop` the route
    /// is gone and the callback drops instead of touching a dead task.
    private func settle(
        _ task: WKURLSchemeTask,
        key: ObjectIdentifier,
        data: Data?,
        response: URLResponse?,
        error: Error?
    ) {
        guard routes[key] != nil else {
            return
        }
        routes.removeValue(forKey: key)
        guard let original = task.request.url else {
            return
        }
        if let error {
            task.didFailWithError(error)
            return
        }
        guard let response else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        // Report against the URL the page asked for, not the forwarded one —
        // the web layer validates same-origin responses.
        let outgoing: URLResponse
        if let http = response as? HTTPURLResponse {
            outgoing = HTTPURLResponse(
                url: original,
                statusCode: http.statusCode,
                httpVersion: nil,
                headerFields: http.allHeaderFields as? [String: String]
            ) ?? response
        } else {
            outgoing = response
        }
        task.didReceive(outgoing)
        task.didReceive(data ?? Data())
        task.didFinish()
    }

    /// The request to fire at the base origin: the task's path and query
    /// re-anchored to the base, method and body preserved, and the
    /// host-identity headers dropped — `Host` is rebuilt by URLSession,
    /// `Cookie` is re-attached from the shared store for the target origin,
    /// and `Origin`/`Referer` name the webview's scheme origin, which means
    /// nothing to the server.
    static func forwardedRequest(for request: URLRequest, to base: URL) -> URLRequest? {
        guard let url = request.url else {
            return nil
        }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.path = url.path
        components?.query = url.query
        guard let target = components?.url else {
            return nil
        }
        var forwarded = URLRequest(url: target)
        forwarded.httpMethod = request.httpMethod
        forwarded.httpBody = bodyData(of: request)
        if let headers = request.allHTTPHeaderFields {
            let dropped: Set<String> = ["host", "origin", "referer", "cookie"]
            forwarded.allHTTPHeaderFields = headers.filter {
                !dropped.contains($0.key.lowercased())
            }
        }
        return forwarded
    }

    /// Scheme tasks expose request bodies through the body stream — WebKit
    /// does not populate `httpBody` — so drain it when present.
    private static func bodyData(of request: URLRequest) -> Data? {
        if let data = request.httpBody {
            return data
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 16 * 1024
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            guard read > 0 else {
                break
            }
            data.append(buffer, count: read)
        }
        return data
    }
}
