/**
 * `cadet upgrade`'s targeting wiring: the command hands its positional
 * argument straight to findAssistant and acts on the resolved entry (or
 * exits with the not-found error). The resolution rules themselves —
 * active ?? first for the bare spelling, exact-ID match for a positional —
 * are pinned in the lockfile layer's tests. The leg's behavior contract
 * lives in the package's remotes-local-upgrade.test.
 */
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import cliPkg from "../../package.json";
import type { LocalAssistant } from "@mycadet/local-mode/contract";
import * as localModeModule from "@mycadet/local-mode";

const realLocalMode = { ...localModeModule };

const findAssistantMock = mock<typeof localModeModule.findAssistant>();
const upgradeAssistantMock = mock<typeof localModeModule.upgradeAssistant>(
  async () => ({ ok: true }),
);

mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  findAssistant: findAssistantMock,
  upgradeAssistant: upgradeAssistantMock,
}));

const { upgrade } = await import("../commands/upgrade.js");

let tempDir: string;
let originalArgv: string[];
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

function makeLocalEntry(): LocalAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-upgrade-target-test-"));
  return {
    assistantId: "local-assistant",
    cloud: "local",
    instanceDir: tempDir,
    daemonPort: 7821,
    port: 7830,
    cesPort: 7822,
  };
}

function makeQuillEntry(
  overrides: Partial<LocalAssistant> = {},
): LocalAssistant {
  return {
    ...makeLocalEntry(),
    assistantId: "quill-uuid",
    name: "Quill",
    ...overrides,
  };
}

beforeEach(() => {
  upgradeAssistantMock.mockReset();
  upgradeAssistantMock.mockImplementation(async () => ({ ok: true }));
  originalArgv = [...process.argv];
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  process.argv = originalArgv;
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("@mycadet/local-mode", () => realLocalMode);
});

function argvFor(...positional: string[]): string[] {
  return [
    "bun",
    "cadet",
    "upgrade",
    ...positional,
    "--version",
    cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
  ];
}

describe("cadet upgrade assistant targeting", () => {
  test("an exact assistant-ID argument resolves via findAssistant", async () => {
    const target = makeQuillEntry({ assistantId: "quill-uuid" });
    process.argv = argvFor("quill-uuid");
    findAssistantMock.mockReturnValue(target);

    await upgrade();

    expect(findAssistantMock).toHaveBeenCalledWith("quill-uuid");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(upgradeAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ assistantId: "quill-uuid" }),
      }),
    );
  });

  test("the bare spelling rides findAssistant's active-first resolution", async () => {
    const active = makeQuillEntry();
    process.argv = argvFor();
    findAssistantMock.mockReturnValue(active);

    await upgrade();

    expect(findAssistantMock).toHaveBeenCalledWith(null);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(upgradeAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ assistantId: "quill-uuid" }),
      }),
    );
  });

  test("an unresolved argument fails with the not-found error", async () => {
    process.argv = argvFor("ghost");
    findAssistantMock.mockReturnValue(null);

    await expect(upgrade()).rejects.toThrow("process.exit(1)");

    expect(upgradeAssistantMock).not.toHaveBeenCalled();
    const errText = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(errText).toContain("No assistant found with name 'ghost'");
  });
});
