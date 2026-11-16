import Foundation
import WebKit

/// Serves the baked web bundle's same-origin API contract: requests under
/// `/v1/` are forwarded over URLSession to the environment's control-plane
/// base — the baked config's `cloudUrl` (the cloud web origin; local dials
/// the control-plane default) — and every other request is handed to
/// Capacitor's stock asset handler.
///
/// Every other Cadet surface keeps this contract one way or another: the
/// web dev server proxies `/v1`, the desktop shell's `app://` protocol
/// handler forwards it, the edge and cloud takeovers route it. The mobile
/// webview's own origin serves only baked assets — the SPA fallback would
/// answer a same-origin `/v1` fetch with index markup — so this handler is
/// the mobile shell's half of the contract.
///
/// Session state rides `HTTPCookieStorage.shared`, explicitly: every
/// forwarded response's `Set-Cookie` headers are parsed and stored against
/// the TARGET origin (the store URLSession would populate implicitly, made
/// explicit so the contract is testable and survives response shapes the
/// implicit path misses — redirects, unusual status codes), and every
/// forward re-attaches the stored cookies for its target in the `Cookie`
/// header. The scheme task has no cookie jar of its own, so the web layer
/// must not expect `document.cookie` to see API session cookies — its
/// fetches carry `credentials: "include"`, and this handler owns the jar.
final class SameOriginAPIHandler: NSObject, WKURLSchemeHandler {
    private let wrapped: WKURLSchemeHandler
    private let base: URL?
    private let session: URLSession

    /// Live routing per accepted task, keyed by identity — `WKURLSchemeTask`
    /// is a protocol, so the identity is the only stable handle, and WebKit
    /// hands the same task object back to `stop`.
    private enum Route {
        case forwarded(URLSessionDataTask, URL)
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
              let request = Self.forwardedRequest(for: task.request, to: base),
              let target = request.url
        else {
            routes[ObjectIdentifier(task)] = .assets
            wrapped.webView(webView, start: task)
            return
        }
        let key = ObjectIdentifier(task)
        let dataTask = session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                self?.settle(task, key: key, target: target, data: data, response: response, error: error)
            }
        }
        routes[key] = .forwarded(dataTask, target)
        dataTask.resume()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        // Dropping the route first turns the in-flight completion into a
        // no-op: a task WebKit stopped may not be told anything further.
        switch routes.removeValue(forKey: key) {
        case .forwarded(let dataTask, _):
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
        target: URL,
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
            Self.storeCookies(from: http, for: target)
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

    /// Persist the response's cookies against the TARGET origin — the jar
    /// the next forward reads. Parsed from the raw header fields rather
    /// than left to URLSession's implicit path so the storage contract is
    /// explicit and test-injectable through `HTTPCookieStorage.shared`.
    static func storeCookies(from response: HTTPURLResponse, for target: URL) {
        let headerFields = response.allHeaderFields
        guard
            let fields = headerFields as? [String: String],
            !fields.isEmpty
        else {
            return
        }
        let tlsTarget = target.scheme?.lowercased() == "https"
        // The cookie parser applies the browser setter policy and drops
        // `Secure` cookies for insecure URLs outright — so on a plain-http
        // target the gateway's session cookies never reach the jar at all
        // (the post-pairing 401). Parse against the target's TLS twin and
        // let `replayable` carry the transport adjustment onto the rebuilt
        // cookie instead.
        let parseTarget = tlsTarget ? target : Self.tlsTwin(of: target)
        let cookies = HTTPCookie
            .cookies(withResponseHeaderFields: fields, for: parseTarget)
            .map { Self.replayable($0, overTLS: tlsTarget) }
        guard !cookies.isEmpty else {
            return
        }
        HTTPCookieStorage.shared.setCookies(cookies, for: target, mainDocumentURL: target)
    }

    private static func tlsTwin(of url: URL) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.scheme = "https"
        return components?.url ?? url
    }

    /// A `Secure` cookie never matches an http URL on the jar's read side —
    /// plain RFC semantics, no exceptions. The gateway stamps `Secure`
    /// unconditionally (the cloud's https origin needs it), including on
    /// its plain-http local loopback, where a real browser still replays
    /// the cookie because `http://localhost` is a trustworthy context. The
    /// forwarder owns the jar for this transport and the server set these
    /// cookies over it, so store them with the transport's actual scheme:
    /// `Secure` kept for https targets, dropped otherwise — replaying to
    /// the host that set the cookie over the transport that carried it
    /// cannot leak it anywhere it has not already traveled.
    private static func replayable(_ cookie: HTTPCookie, overTLS: Bool) -> HTTPCookie {
        guard !overTLS, cookie.isSecure else {
            return cookie
        }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: cookie.name,
            .value: cookie.value,
            .domain: cookie.domain,
            .path: cookie.path,
        ]
        if let expires = cookie.expiresDate {
            properties[.expires] = expires
        }
        return HTTPCookie(properties: properties) ?? cookie
    }

    /// The request to fire at the base origin: the task's path and query
    /// re-anchored to the base, method and body preserved, and the
    /// host-identity headers dropped — `Host` is rebuilt by URLSession,
    /// and `Origin`/`Referer` name the webview's scheme origin, which means
    /// nothing to the server. The `Cookie` header is rebuilt from the
    /// shared store for the TARGET origin — the jar this handler's own
    /// `storeCookies` populates — so a session a previous forward earned
    /// rides every subsequent one.
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
        if let cookies = HTTPCookieStorage.shared.cookies(for: target), !cookies.isEmpty {
            let header = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
            forwarded.setValue(header, forHTTPHeaderField: "Cookie")
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
