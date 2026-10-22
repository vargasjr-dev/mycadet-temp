import XCTest

final class StampedHandoffURLTests: XCTestCase {
    func testParsesTheStampedPayload() {
        let html = """
            <html><head><script>window.__CADET_CONFIG__=\
            {"remote":"cloud","cloudUrl":"https://mycadet.ai"}\
            </script></head><body></body></html>
            """
        XCTAssertEqual(
            StampedHandoffURL.parse(html)?.absoluteString,
            "https://mycadet.ai"
        )
    }

    func testIsNilWhenTheStampIsAbsentOrGarbage() {
        XCTAssertNil(StampedHandoffURL.parse("<html><head></head></html>"))
        XCTAssertNil(StampedHandoffURL.parse("not html"))
        XCTAssertNil(StampedHandoffURL.parse(""))
        XCTAssertNil(
            StampedHandoffURL.parse(
                "<script>window.__CADET_CONFIG__=</script>"
            )
        )
        XCTAssertNil(
            StampedHandoffURL.parse(
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
            {"remote":"custom","cloudUrl":"https://x.example/?a=\u{003C}/script\u{003E}"}\
            </script>
            """
        XCTAssertNil(StampedHandoffURL.parse(html))
    }
}
