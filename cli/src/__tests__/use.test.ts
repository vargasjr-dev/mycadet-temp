import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getActiveAssistant } from "@mycadet/local-mode";
import { join } from "node:path";

import { setActiveAssistant } from "../lib/assistant-config.js";
import { use } from "../commands/use.js";
import { makeEntry } from "./helpers/lockfile-entry.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-use-test-"));
const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

describe("cadet use", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = testDir;
    rmSync(join(testDir, "cadet", "lockfile.json"), { force: true });
    process.argv = ["bun", "cadet", "use"];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("sets active assistant by unique display name", async () => {
    makeEntry({ assistantId: "assistant-1", name: "Alice" });
    makeEntry({ assistantId: "assistant-2", name: "Bob" });
    process.argv = ["bun", "cadet", "use", "Alice"];

    await use();

    expect(getActiveAssistant()).toBe("assistant-1");
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Active assistant set to Alice.",
    );
  });

  test("sets active assistant by unquoted multi-word display name", async () => {
    makeEntry({ assistantId: "assistant-1", name: "Example Assistant" });
    makeEntry({ assistantId: "assistant-2", name: "Bob" });
    process.argv = ["bun", "cadet", "use", "Example", "Assistant"];

    await use();

    expect(getActiveAssistant()).toBe("assistant-1");
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Active assistant set to Example Assistant.",
    );
  });

  test("prints active assistant with display name and id", async () => {
    makeEntry({ assistantId: "assistant-1", name: "Alice" });
    setActiveAssistant("assistant-1");

    await use();

    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Active assistant: Alice",
    );
  });

  test("rejects ambiguous display names without changing active assistant", async () => {
    makeEntry({ assistantId: "assistant-1", name: "Alice" });
    makeEntry({ assistantId: "assistant-2", name: "Alice" });
    setActiveAssistant("assistant-2");
    process.argv = ["bun", "cadet", "use", "Alice"];

    await expect(use()).rejects.toThrow("process.exit:1");

    expect(getActiveAssistant()).toBe("assistant-2");
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Multiple assistants match 'Alice'");
    expect(output).toContain("assistant-1");
    expect(output).toContain("assistant-2");
  });
});
