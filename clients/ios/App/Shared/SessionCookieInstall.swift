import Foundation

/// Bridges a freshly minted session token into the cookie jar the
/// same-origin forwarder reads (`HTTPCookieStorage.shared`).
///
/// Why this exists: the headless `provider/token` exchange carries the
/// session token in its response body — it never `Set-Cookie`s — and the
/// web layer's `document.cookie` install is scoped to the webview's own
/// scheme origin, which the shared jar never sees. Without a native
/// install, the first `/v1` forward after pairing goes out without a
/// session and 401s.
///
/// Foundation-only (no Capacitor), so the host-less test suite compiles it.
enum SessionCookieInstall {
    /// Installs the token as session cookies for the base origin's host:
    /// `sessionid` always, `__Secure-sessionid` only over https (the
    /// prefix promises a secure context). Host-only domain, `Path=/` so
    /// every `/v1` route matches, and the jar is injectable for tests.
    static func install(token: String, for baseURL: URL, jar: HTTPCookieStorage = .shared) {
        for cookie in cookies(token: token, for: baseURL) {
            jar.setCookie(cookie)
        }
    }

    static func cookies(token: String, for baseURL: URL) -> [HTTPCookie] {
        guard let host = baseURL.host, !host.isEmpty else {
            return []
        }
        let secure = baseURL.scheme == "https"
        var names = ["sessionid"]
        if secure {
            names.append("__Secure-sessionid")
        }
        return names.compactMap { name in
            var properties: [HTTPCookie.PropertyKey: Any] = [
                .name: name,
                .value: token,
                .domain: host,
                .path: "/",
            ]
            if secure {
                properties[.secure] = "TRUE"
            }
            return HTTPCookie(properties: properties)
        }
    }
}
