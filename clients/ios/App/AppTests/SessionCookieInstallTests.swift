import XCTest

/// The pairing → first-request regression: the session token arrives in
/// the exchange's response BODY, so without a native install the shared
/// jar stays empty and the first `/v1` forward 401s.
final class SessionCookieInstallTests: XCTestCase {
    private let httpsBase = URL(string: "https://test.mycadet.ai")!
    private let httpBase = URL(string: "http://localhost:7840")!

    override func tearDown() {
        // The shared jar is process-global; clear what a test stored so the
        // next test starts empty.
        for cookie in HTTPCookieStorage.shared.cookies ?? [] {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        super.tearDown()
    }

    // ── the install itself ──────────────────────────────────────────────

    func testHTTPSInstallsBothCookieNamesHostOnlyWithPathRoot() {
        let cookies = SessionCookieInstall.cookies(
            token: "tok-123", for: httpsBase
        )
        XCTAssertEqual(Set(cookies.map(\.name)), ["sessionid", "__Secure-sessionid"])
        for cookie in cookies {
            XCTAssertEqual(cookie.value, "tok-123")
            XCTAssertEqual(cookie.domain, "test.mycadet.ai")
            XCTAssertEqual(cookie.path, "/")
            XCTAssertTrue(cookie.isSecure)
        }
    }

    func testHTTPInstallsOnlyThePlainSessionCookie() {
        let cookies = SessionCookieInstall.cookies(token: "tok-123", for: httpBase)
        // The `__Secure-` prefix promises a secure context; plain http gets
        // the one name that carries no such promise.
        XCTAssertEqual(cookies.map(\.name), ["sessionid"])
        XCTAssertFalse(cookies[0].isSecure)
        XCTAssertEqual(cookies[0].domain, "localhost")
    }

    func testAHostlessURLInstallsNothing() {
        let cookies = SessionCookieInstall.cookies(
            token: "tok-123", for: URL(string: "not-a-url")!
        )
        XCTAssertTrue(cookies.isEmpty)
    }

    // ── the pairing regression: the first forward carries the session ───

    func testFirstForwardAfterPairingCarriesTheSession() throws {
        SessionCookieInstall.install(token: "tok-123", for: httpsBase)

        var request = URLRequest(url: URL(string: "capacitor://localhost/v1/assistants/")!)
        request.httpMethod = "GET"
        let forwarded = try XCTUnwrap(
            SameOriginAPIHandler.forwardedRequest(for: request, to: httpsBase)
        )
        let cookieHeader = try XCTUnwrap(
            forwarded.value(forHTTPHeaderField: "Cookie")
        )
        XCTAssertTrue(cookieHeader.contains("sessionid=tok-123"))
        XCTAssertTrue(cookieHeader.contains("__Secure-sessionid=tok-123"))
    }
}
