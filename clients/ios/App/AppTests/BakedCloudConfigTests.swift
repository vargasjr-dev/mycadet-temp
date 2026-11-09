import XCTest

final class BakedCloudConfigTests: XCTestCase {
    func testParsesTheBakedConfig() {
        let config = """
            {"appName":"Cadet","plugins":{"CadetCloud":\
            {"cloudUrl":"https://mycadet.ai"}},"server":{}}
            """.data(using: .utf8)!
        XCTAssertEqual(
            BakedCloudConfig.parse(config)?.absoluteString,
            "https://mycadet.ai"
        )
    }

    func testIsNilWhenTheConfigIsAbsentOrGarbage() {
        XCTAssertNil(BakedCloudConfig.parse(Data()))
        XCTAssertNil(BakedCloudConfig.parse("not json".data(using: .utf8)!))
        XCTAssertNil(
            BakedCloudConfig.parse(
                #"{"appName":"Cadet"}"#.data(using: .utf8)!
            )
        )
        XCTAssertNil(
            BakedCloudConfig.parse(
                #"{"plugins":{"CadetCloud":{"cloudUrl":"https://mycadet.ai"}}}"#
                    .replacingOccurrences(of: "CadetCloud", with: "CadetOther")
                    .data(using: .utf8)!
            )
        )
    }

    func testDropsPayloadsWithIllegalURLCharacters() {
        // The config is plain JSON, so a value can carry any string —
        // URL(string:) rejects the ones that aren't URLs.
        XCTAssertNil(
            BakedCloudConfig.parse(
                #"{"plugins":{"CadetCloud":{"cloudUrl":"ht tp://x example"}}}"#
                    .data(using: .utf8)!
            )
        )
    }
}
