import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  collectStartupServiceLogs,
  detectStartupFailureHints,
  reportStartupFailureDiagnostics,
  tailLines,
} from "../lib/startup-diagnostics.js";
import type { LifecycleReporter } from "../lib/lifecycle-reporter.js";
import type { LocalAssistantResources } from "@mycadet/local-mode";

function capturingReporter(): {
  output: string[];
  reporter: LifecycleReporter;
} {
  const output: string[] = [];
  return {
    output,
    reporter: {
      progress: () => {},
      log: (message: string) => output.push(message),
      warn: (message: string) => output.push(message),
      error: (message: string) => output.push(message),
    },
  };
}

describe("collectStartupServiceLogs", () => {
  test("keys the assistant and gateway logs off the instance dir", () => {
    /**
     * Tests that per-instance services read from the instance's logs
     * directory while the credential-executor shares hatch.log.
     */

    // GIVEN an instance with its own directory
    const resources: LocalAssistantResources = {
      instanceDir: "/tmp/some-instance",
      gatewayPort: 7811,
      daemonPort: 7821,
    };

    // WHEN the service logs are collected
    const logs = collectStartupServiceLogs(resources);

    // THEN each service maps to the file its output is piped into
    expect(logs.map((log) => log.service)).toEqual([
      "assistant",
      "credential-executor",
      "gateway",
    ]);
    expect(logs[0]!.path).toBe("/tmp/some-instance/logs/assistant-stdout.log");
    expect(logs[2]!.path).toBe("/tmp/some-instance/logs/gateway-stdout.log");
    expect(logs[1]!.path.endsWith("hatch.log")).toBe(true);
  });
});

describe("tailLines", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cadet-startup-diag-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns the last N lines of an existing file", () => {
    /**
     * Tests that the tail keeps only the requested suffix, dropping blanks.
     */

    // GIVEN a log with more lines than the tail asks for
    const path = join(tempDir, "service.log");
    writeFileSync(path, "one\ntwo\n\nthree\nfour\n");

    // WHEN the last two lines are read
    const lines = tailLines(path, 2);

    // THEN the suffix survives and blank lines do not
    expect(lines).toEqual(["three", "four"]);
  });

  test("returns [] for a missing file", () => {
    /**
     * Tests that a service which never wrote output reads as empty rather
     * than throwing.
     */

    // GIVEN no file at the path
    // WHEN its tail is read
    // THEN the result is empty
    expect(tailLines(join(tempDir, "missing.log"), 10)).toEqual([]);
  });
});

describe("detectStartupFailureHints", () => {
  test("flags a port collision from the newest matching line", () => {
    /**
     * Tests that EADDRINUSE surfaces with the matched line attached.
     */

    // GIVEN a daemon log tail ending in a bind failure
    const lines = [
      "2026-02-13T10:00:00.000Z [daemon] listening on 7821",
      "2026-02-13T10:00:01.000Z [daemon] error: EADDRINUSE 127.0.0.1:7821",
    ];

    // WHEN hints are detected
    const hints = detectStartupFailureHints(lines);

    // THEN the port-collision hint carries the matching line
    expect(hints).toHaveLength(1);
    expect(hints[0]!.hint).toContain("already in use");
    expect(hints[0]!.line).toContain("EADDRINUSE");
  });

  test("deduplicates repeated hits and caps the result", () => {
    /**
     * Tests that one hint per cause is kept even when many lines match.
     */

    // GIVEN a tail where every line matches the same pattern
    const lines = Array.from(
      { length: 10 },
      (_, i) => `error: EACCES attempt ${i}`,
    );

    // WHEN hints are detected
    const hints = detectStartupFailureHints(lines);

    // THEN a single deduplicated hint comes back
    expect(hints).toHaveLength(1);
  });

  test("returns [] for a clean log tail", () => {
    /**
     * Tests that ordinary startup lines produce no hints.
     */

    // GIVEN a tail with no known failure patterns
    // WHEN hints are detected
    // THEN none are
    expect(detectStartupFailureHints(["ready", "migrations done"])).toEqual([]);
  });
});

describe("reportStartupFailureDiagnostics", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cadet-startup-diag-"));
    mkdirSync(join(tempDir, "logs"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const resources = (): LocalAssistantResources => ({
    instanceDir: tempDir,
    gatewayPort: 7811,
    daemonPort: 7821,
  });

  test("lists written logs and likely causes without prompting when non-interactive", async () => {
    /**
     * Tests that a non-interactive failure still points the operator at the
     * log files and scans them for a cause.
     */

    // GIVEN an assistant log whose tail shows a bind failure
    writeFileSync(
      join(tempDir, "logs", "assistant-stdout.log"),
      "error: listen EADDRINUSE 127.0.0.1:7821\n",
    );
    const { output, reporter } = capturingReporter();

    // WHEN the failure diagnostics are reported non-interactively
    await reportStartupFailureDiagnostics(resources(), {
      reporter,
      interactive: false,
    });

    // THEN the log path and the likely cause reach the reporter, with no
    // prompt written
    const joined = output.join("\n");
    expect(joined).toContain("assistant-stdout.log");
    expect(joined).toContain("already in use");
  });

  test("shows the tail of the log the operator picks, then stops on blank input", async () => {
    /**
     * Tests the interactive loop: the chosen log's tail is printed and a
     * blank answer ends the prompt loop.
     */

    // GIVEN one service log with content and a prompt that picks it, then skips
    writeFileSync(join(tempDir, "logs", "gateway-stdout.log"), "gateway died\n");
    const { output, reporter } = capturingReporter();
    const answers = ["1", ""];
    let call = 0;

    // WHEN the failure diagnostics are reported interactively
    await reportStartupFailureDiagnostics(resources(), {
      reporter,
      interactive: true,
      promptLineFn: async () => answers[call++]!,
    });

    // THEN the gateway tail is shown once and the loop exits
    const joined = output.join("\n");
    expect(joined).toContain("gateway died");
    expect(call).toBe(2);
  });

  test("never throws when a diagnostic read fails", async () => {
    /**
     * Tests that diagnostics are best effort: an injected tail that throws
     * cannot mask the caller's original error.
     */

    // GIVEN a tailLinesFn that explodes
    const { reporter } = capturingReporter();

    // WHEN the failure diagnostics are reported
    // THEN they resolve without throwing
    await reportStartupFailureDiagnostics(resources(), {
      reporter,
      interactive: true,
      tailLinesFn: () => {
        throw new Error("disk on fire");
      },
      promptLineFn: async () => "",
    });
  });
});
