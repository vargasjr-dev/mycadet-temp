import XCTest

final class StampedHandoffURLTests: XCTestCase {
    func testParsesTheStampedPayload() {
        let html = """
            <html><head><script>window.__CADET_CONFIG__=\
            {"remote":"cloud","handoffUrl":"https://mycadet.ai/assistant"}\
            </script></head><body></body></html>
            """
        XCTAssertEqual(
            SelfHostedServer.parseStampedHandoffURL(html)?.absoluteString,
            "https://mycadet.ai/assistant"
        )
    }

    func testIsNilWhenTheStampIsAbsentOrGarbage() {
        XCTAssertNil(SelfHostedServer.parseStampedHandoffURL("<html><head></head></html>"))
        XCTAssertNil(SelfHostedServer.parseStampedHandoffURL("not html"))
        XCTAssertNil(SelfHostedServer.parseStampedHandoffURL(""))
        XCTAssertNil(
            SelfHostedServer.parseStampedHandoffURL(
                "<script>window.__CADET_CONFIG__=</script>"
            )
        )
        XCTAssertNil(
            SelfHostedServer.parseStampedHandoffURL(
                "<script>window.__CADET_CONFIG__={\"remote\":\"cloud\"}</script>"
            )
        )
    }

    func testDropsPayloadsWithIllegalURLCharacters() {
        // The stamp escapes `<` so the payload can't break out of the script
        // tag; JSON decoding turns it back into a literal, which
        // URL(string:) rejects.
        let html = """
            <script>window.__CADET_CONFIG__=\
            {"remote":"custom","handoffUrl":"https://x.example/?a=\u{003C}/script\u{003E}"}\
            </script>
            """
        XCTAssertNil(SelfHostedServer.parseStampedHandoffURL(html))
    }
}
