/**
 * `cadet upgrade`'s targeting wiring: the assistant-resolution ceremony at
 * the command edge (exact-ID wins, unique display-name resolves, ambiguous
 * names list the matches). The lookup rules themselves are pinned in
 * `assistant-config.test.ts`; these tests stub the shared helper's result
 * and assert the command acts on it. The leg's behavior contract lives in
 * the package's remotes-local-upgrade.test.
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

const lookupAssistantByIdentifierMock =
  mock<typeof localModeModule.lookupAssistantByIdentifier>();
const upgradeAssistantMock = mock<typeof localModeModule.upgradeAssistant>(
  async () => ({ ok: true }),
);

mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  lookupAssistantByIdentifier: lookupAssistantByIdentifierMock,
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
  test("resolves a unique display-name match to its assistant", async () => {
    const quill = makeQuillEntry();
    process.argv = argvFor("Quill");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "found",
      entry: quill,
    });

    await upgrade();

    expect(lookupAssistantByIdentifierMock).toHaveBeenCalledWith("Quill");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(upgradeAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ assistantId: "quill-uuid" }),
      }),
    );
  });

  test("resolves a multi-word display-name argument, unsplit by --version", async () => {
    const multiWord = makeQuillEntry({ name: "My Assistant" });
    process.argv = argvFor("My", "Assistant");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "found",
      entry: multiWord,
    });

    await upgrade();

    expect(lookupAssistantByIdentifierMock).toHaveBeenCalledWith(
      "My Assistant",
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(upgradeAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ assistantId: "quill-uuid" }),
      }),
    );
  });

  test("an exact assistant-ID argument resolves via the shared helper's found result", async () => {
    // `lookupAssistantByIdentifier` owns ID-wins-over-name precedence
    // (covered in assistant-config.test.ts); this only checks that
    // `cadet upgrade` passes the raw argument through unmodified and acts
    // on whatever entry the shared helper resolves.
    const target = makeQuillEntry({ assistantId: "quill-uuid" });
    process.argv = argvFor("quill-uuid");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "found",
      entry: target,
    });

    await upgrade();

    expect(lookupAssistantByIdentifierMock).toHaveBeenCalledWith("quill-uuid");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(upgradeAssistantMock).toHaveBeenCalled();
  });

  test("an ambiguous display name fails and lists the matching IDs", async () => {
    process.argv = argvFor("Quill");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "ambiguous",
      matches: [
        makeQuillEntry({ assistantId: "quill-uuid-1" }),
        makeQuillEntry({ assistantId: "quill-uuid-2" }),
      ],
    });

    await expect(upgrade()).rejects.toThrow("process.exit(1)");

    expect(upgradeAssistantMock).not.toHaveBeenCalled();
    const errText = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(errText).toContain("Multiple assistants match 'Quill'");
    expect(errText).toContain("quill-uuid-1");
    expect(errText).toContain("quill-uuid-2");
  });
});
