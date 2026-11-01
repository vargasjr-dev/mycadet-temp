import { describe, expect, spyOn, test } from "bun:test";

import { consoleLifecycleReporter } from "../lifecycle-reporter.js";

describe("consoleLifecycleReporter", () => {
  test("routes log/warn/error to the matching console methods", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    consoleLifecycleReporter.log("hello");
    consoleLifecycleReporter.warn("careful");
    consoleLifecycleReporter.error("boom");

    expect(logSpy).toHaveBeenCalledWith("hello");
    expect(warnSpy).toHaveBeenCalledWith("careful");
    expect(errorSpy).toHaveBeenCalledWith("boom");

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("renders each progress step as an active [step/total] status line", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    consoleLifecycleReporter.progress(3, 6, "Starting assistant...");

    expect(logSpy).toHaveBeenCalledWith("[3/6] Starting assistant...");

    logSpy.mockRestore();
  });
});
