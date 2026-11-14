import XCTest

final class SameOriginAPIHandlerTests: XCTestCase {
    private let base = URL(string: "http://localhost:7840")!

    override func tearDown() {
        // The shared jar is process-global; clear what a test stored so the
        // next test starts empty.
        for cookie in HTTPCookieStorage.shared.cookies ?? [] {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        super.tearDown()
    }

    // ── forwardedRequest — the re-anchoring + cookie replay ────────────────

    func testReanchorsPathAndQueryOntoTheBase() throws {
        var request = URLRequest(
            url: URL(string: "capacitor://localhost/v1/assistants/?limit=5")!
        )
        request.httpMethod = "GET"
        let forwarded = try XCTUnwrap(
            SameOriginAPIHandler.forwardedRequest(for: request, to: base)
        )
        // URLComponents normalizes the empty last path segment away once a
        // query rides along — harmless since the route table answers both
        // trailing-slash spellings of every route.
        XCTAssertEqual(
            forwarded.url?.absoluteString,
            "http://localhost:7840/v1/assistants?limit=5"
        )
        XCTAssertEqual(forwarded.httpMethod, "GET")

        let noQuery = URLRequest(
            url: URL(string: "capacitor://localhost/v1/assistants/")!
        )
        let reanchored = try XCTUnwrap(
            SameOriginAPIHandler.forwardedRequest(for: noQuery, to: base)
        )
        // URLComponents normalizes the trailing slash on every
        // reconstruction — harmless since the route table answers both
        // trailing-slash spellings of every route.
        XCTAssertEqual(
            reanchored.url?.absoluteString,
            "http://localhost:7840/v1/assistants"
        )
    }

    func testReplaysStoredCookiesForTheTargetOrigin() throws {
        HTTPCookieStorage.shared.setCookie(
            HTTPCookie(
                properties: [
                    .name: "sessionid",
                    .value: "abc",
                    .domain: "localhost",
                    .path: "/",
                ]
            )!
        )
        var request = URLRequest(
            url: URL(string: "capacitor://localhost/v1/assistants/")!
        )
        request.allHTTPHeaderFields = ["Cookie": "stale-browser-jar=1"]
        let forwarded = try XCTUnwrap(
            SameOriginAPIHandler.forwardedRequest(for: request, to: base)
        )
        // The browser jar's Cookie header is dropped wholesale and rebuilt
        // from the shared store — the jar this handler owns.
        XCTAssertEqual(forwarded.value(forHTTPHeaderField: "Cookie"), "sessionid=abc")
    }

    func testSendsNoCookieHeaderWhenTheStoreIsEmpty() throws {
        var request = URLRequest(
            url: URL(string: "capacitor://localhost/v1/assistants/")!
        )
        request.allHTTPHeaderFields = ["Cookie": "stale-browser-jar=1"]
        let forwarded = try XCTUnwrap(
            SameOriginAPIHandler.forwardedRequest(for: request, to: base)
        )
        XCTAssertNil(forwarded.value(forHTTPHeaderField: "Cookie"))
    }

    func testDropsHostIdentityHeaders() throws {
        var request = URLRequest(
            url: URL(string: "capacitor://localhost/v1/assistants/")!
        )
        request.allHTTPHeaderFields = [
            "Host": "localhost",
            "Origin": "capacitor://localhost",
            "Referer": "capacitor://localhost/account",
            "Accept": "application/json",
        ]
        let forwarded = try XCTUnwrap(
            SameOriginAPIHandler.forwardedRequest(for: request, to: base)
        )
        XCTAssertNil(forwarded.value(forHTTPHeaderField: "Host"))
        XCTAssertNil(forwarded.value(forHTTPHeaderField: "Origin"))
        XCTAssertNil(forwarded.value(forHTTPHeaderField: "Referer"))
        XCTAssertEqual(
            forwarded.value(forHTTPHeaderField: "Accept"),
            "application/json"
        )
    }

    // ── storeCookies — the Set-Cookie persistence arm ──────────────────────

    func testStoresResponseCookiesAgainstTheTargetOrigin() throws {
        let response = HTTPURLResponse(
            url: base,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [
                "Set-Cookie": "sessionid=abc; Path=/; Max-Age=1209600"
            ]
        )!
        SameOriginAPIHandler.storeCookies(from: response, for: base)
        let stored = HTTPCookieStorage.shared.cookies(for: base) ?? []
        XCTAssertEqual(
            stored.first(where: { $0.name == "sessionid" })?.value,
            "abc"
        )
    }

    func testStoresNothingWithoutSetCookieHeaders() throws {
        let response = HTTPURLResponse(
            url: base,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        SameOriginAPIHandler.storeCookies(from: response, for: base)
        XCTAssertEqual(HTTPCookieStorage.shared.cookies(for: base) ?? [], [])
    }
}
