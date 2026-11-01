import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadAllAssistants } from "@mycadet/local-mode";
import { join } from "node:path";

import { makeEntry, readEntry } from "./helpers/lockfile-entry.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-retire-test-"));
const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;
const originalStdinIsRaw = process.stdin.isRaw;
const originalSetRawMode = process.stdin.setRawMode;
const originalStdoutWrite = process.stdout.write;

// The command delegates the teardown to the package's retire operation; the
// mock replaces the operation at the package seam (the command's import
// site) while the lookup/display helpers stay real, reading the sandboxed
// lockfile.
const realLocalMode = { ...(await import("@mycadet/local-mode")) };
const retireAssistantMock = mock(
  async (): Promise<
    { ok: true } | { ok: false; status: number; error: string }
  > => ({
    ok: true,
  }),
);

mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  retireAssistant: retireAssistantMock,
}));

afterAll(() => {
  mock.module("@mycadet/local-mode", () => realLocalMode);
});

import { retire } from "../commands/retire.js";

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let consoleWarnSpy: ReturnType<typeof spyOn>;

function readLockfile(): string {
  return readFileSync(join(testDir, "cadet", "lockfile.json"), "utf-8");
}

function setTerminalMode(isTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: isTTY,
  });
}

function setInteractiveTerminal(): void {
  setTerminalMode(true);
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    value: mock(() => process.stdin),
  });
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function restoreTerminal(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: originalStdinIsTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalStdoutIsTTY,
  });
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: originalStdinIsRaw,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    value: originalSetRawMode,
  });
  process.stdout.write = originalStdoutWrite;
}

describe("cadet retire", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = testDir;
    for (const name of [
      join("cadet", "lockfile.json"),
      ".cadet.lock.json",
      ".cadet.lockfile.json",
    ]) {
      rmSync(join(testDir, name), { force: true });
    }
    process.argv = ["bun", "cadet", "retire"];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit;
    retireAssistantMock.mockReset();
    retireAssistantMock.mockResolvedValue({ ok: true });
    setTerminalMode(false);
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    restoreTerminal();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  afterAll(() => {
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("--yes retires by unquoted display name and removes by assistant ID", async () => {
    makeEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
    });
    const entry = readEntry("assistant-1");
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant", "--yes"];

    await retire();

    expect(retireAssistantMock).toHaveBeenCalledWith(entry);
    // The lockfile removal is the OPERATION's act (pinned in the package
    // suite, which runs the real dispatch) — the stubbed command must not
    // have touched it.
    expect(loadAllAssistants()).toHaveLength(1);
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Name: Example Assistant");
    expect(output).toContain("ID: assistant-1");
  });

  test("a failed operation prints the error and exits 1", async () => {
    makeEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
    });
    retireAssistantMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: "Failed to archive /data: disk full",
    });
    process.argv = ["bun", "cadet", "retire", "assistant-1", "--yes"];

    await expect(retire()).rejects.toThrow("process.exit:1");

    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Error: Failed to archive /data: disk full");
  });

  test("non-interactive retire without --yes fails before deleting", async () => {
    makeEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
    });
    const before = readLockfile();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant"];

    await expect(retire()).rejects.toThrow("process.exit:1");

    expect(retireAssistantMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Refusing to retire without confirmation");
    expect(output).toContain("--yes");
  });

  test("interactive cancel leaves the assistant untouched", async () => {
    makeEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
    });
    const before = readLockfile();
    setInteractiveTerminal();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant"];

    const pending = retire();
    queueMicrotask(() => {
      process.stdin.emit("data", Buffer.from("q"));
    });

    await expect(pending).rejects.toThrow("process.exit:1");
    expect(retireAssistantMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Retire cancelled.",
    );
  });

  test("interactive confirmation retires the assistant", async () => {
    makeEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
    });
    const entry = readEntry("assistant-1");
    setInteractiveTerminal();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant"];

    const pending = retire();
    queueMicrotask(() => {
      process.stdin.emit("data", Buffer.from([13]));
    });

    await pending;
    expect(retireAssistantMock).toHaveBeenCalledWith(entry);
  });

  test("ambiguous display names fail before deleting", async () => {
    makeEntry({ assistantId: "assistant-1", name: "Example Assistant" });
    makeEntry({ assistantId: "assistant-2", name: "Example Assistant" });
    const before = readLockfile();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant", "--yes"];

    await expect(retire()).rejects.toThrow("process.exit:1");

    expect(retireAssistantMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Multiple assistants match 'Example Assistant'");
    expect(output).toContain("assistant-1");
    expect(output).toContain("assistant-2");
  });
});
