import Foundation
import MacHelperCore

// Helper-local recreations of the daemon wire types for computer-use
// results. Field names/shapes mirror the shared MessageTypes.

// MARK: - Computer Use

struct HostCuResultPayload {
    let requestId: String
    var axTree: String?
    var axDiff: String?
    var screenshot: String?
    var screenshotWidthPx: Int?
    var screenshotHeightPx: Int?
    var screenWidthPt: Int?
    var screenHeightPt: Int?
    var executionResult: String?
    var executionError: String?
    var secondaryWindows: String?
    /// Whole milliseconds spent in each phase of the step, keyed by phase name.
    var timings: [String: Int]?

    init(
        requestId: String,
        axTree: String? = nil,
        axDiff: String? = nil,
        screenshot: String? = nil,
        screenshotWidthPx: Int? = nil,
        screenshotHeightPx: Int? = nil,
        screenWidthPt: Int? = nil,
        screenHeightPt: Int? = nil,
        executionResult: String? = nil,
        executionError: String? = nil,
        secondaryWindows: String? = nil,
        timings: [String: Int]? = nil
    ) {
        self.requestId = requestId
        self.axTree = axTree
        self.axDiff = axDiff
        self.screenshot = screenshot
        self.screenshotWidthPx = screenshotWidthPx
        self.screenshotHeightPx = screenshotHeightPx
        self.screenWidthPt = screenWidthPt
        self.screenHeightPt = screenHeightPt
        self.executionResult = executionResult
        self.executionError = executionError
        self.secondaryWindows = secondaryWindows
        self.timings = timings
    }

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = ["requestId": requestId]
        if let axTree { dict["axTree"] = axTree }
        if let axDiff { dict["axDiff"] = axDiff }
        if let screenshot { dict["screenshot"] = screenshot }
        if let screenshotWidthPx { dict["screenshotWidthPx"] = screenshotWidthPx }
        if let screenshotHeightPx { dict["screenshotHeightPx"] = screenshotHeightPx }
        if let screenWidthPt { dict["screenWidthPt"] = screenWidthPt }
        if let screenHeightPt { dict["screenHeightPt"] = screenHeightPt }
        if let executionResult { dict["executionResult"] = executionResult }
        if let executionError { dict["executionError"] = executionError }
        if let secondaryWindows { dict["secondaryWindows"] = secondaryWindows }
        if let timings { dict["timings"] = timings }
        return dict
    }
}
