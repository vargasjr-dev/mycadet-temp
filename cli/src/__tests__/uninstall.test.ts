import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { uninstall } from "../commands/uninstall.js";
import {
  getInputHistoryPath,
  getSharedStateDir,
} from "../lib/environments/paths.js";
import {
  resolveConfigDir,
  resolveDataDir,
  resolveLogDir,
} from "@mycadet/local-mode";
import { makeEntry } from "./helpers/lockfile-entry.js";

// The command reads its argv at call time.
const ORIGINAL_ARGV = process.argv;

// retireDocker is the one retirement path with observable side effects
// (docker teardown), and uninstall is the only importer in its graph.
// Mocked module-wide so tests pin WHEN it runs — never before the
// confirmation gate — as much as whether it runs.
const retireDockerCalls: string[] = [];
let onRetireDocker: ((name: string) => void) | undefined;

// uninstall imports the retirement legs from the package now; the mock
// replaces retireDocker at that seam (the one retirement path with
// observable side effects) while the rest of the surface stays real.
const realLocalMode = { ...(await import("@mycadet/local-mode")) };
mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  retireDocker: (name: string) => {
    retireDockerCalls.push(name);
    onRetireDocker?.(name);
  },
}));

// Every XDG location the command touches MUST be redirected: the homedir
// fallback would otherwise point at the real user's data dirs.
function redirectXdg(): string {
  const root = mkdtempSync(join(tmpdir(), "cadet-uninstall-"));
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.CADET_ENVIRONMENT = "production";
  mkdirSync(join(root, "config", "cadet"), { recursive: true });
  return root;
}

const RESTORED_ENV_KEYS = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "CADET_ENVIRONMENT",
] as const;

function withRestoredEnv(run: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(
    RESTORED_ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  return run().finally(() => {
    for (const k of RESTORED_ENV_KEYS) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k]!;
    }
    process.argv = ORIGINAL_ARGV;
  });
}

describe("cadet uninstall", () => {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

  function printedOutput(): string {
    return logSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .join("\n");
  }

  afterEach(() => {
    retireDockerCalls.length = 0;
    onRetireDocker = undefined;
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  afterAll(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("warns that remaining assistants will be retired, then proceeds to the confirm gate", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();
      // A remaining assistant is retired — with its data deleted — as part
      // of the uninstall AFTER the user confirms; the pre-confirm summary
      // says so up front (v0.0.10 run feedback: the hard refusal just
      // blocked the uninstall; the fs sweep deletes the archives anyway).
      makeEntry({ assistantId: "test-assistant" });

      const exitMock = spyOn(process, "exit");
      exitMock.mockImplementation(
        (code?: number | string | undefined): never => {
          throw new Error(`process.exit:${code}`);
        },
      );
      try {
        // Non-interactive without --yes, the CONFIRM gate is what refuses —
        // not an assistant guard.
        await expect(uninstall()).rejects.toThrow("process.exit:1");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("1 assistant still exists"),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("will be retired as part of this uninstall"),
        );
        expect(errorSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("Retire them first"),
        );
      } finally {
        exitMock.mockRestore();
      }
      rmSync(root, { recursive: true, force: true });
    });
  });

  test("refuses non-interactively without --yes", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();

      const exitMock = spyOn(process, "exit");
      exitMock.mockImplementation(
        (code?: number | string | undefined): never => {
          throw new Error(`process.exit:${code}`);
        },
      );
      try {
        process.argv = ["bun", "cadet", "uninstall"];
        await expect(uninstall()).rejects.toThrow("process.exit:1");
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("non-interactive"),
        );
      } finally {
        exitMock.mockRestore();
      }
      rmSync(root, { recursive: true, force: true });
    });
  });

  test("does not retire assistants when the confirm gate refuses", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();
      makeEntry({ assistantId: "docker-assistant", cloud: "docker" });

      const exitMock = spyOn(process, "exit");
      exitMock.mockImplementation(
        (code?: number | string | undefined): never => {
          throw new Error(`process.exit:${code}`);
        },
      );
      try {
        process.argv = ["bun", "cadet", "uninstall"];
        await expect(uninstall()).rejects.toThrow("process.exit:1");
      } finally {
        exitMock.mockRestore();
      }
      // Retirement is part of the confirmed flow — a refusal must leave the
      // assistant's docker resources untouched.
      expect(retireDockerCalls).toEqual([]);

      rmSync(root, { recursive: true, force: true });
    });
  });

  test("--yes retires remaining assistants after the deletion list is shown", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();
      makeEntry({ assistantId: "docker-assistant", cloud: "docker" });
      mkdirSync(resolveConfigDir(), {
        recursive: true,
      });

      // Capture what had been printed by the time retirement ran — the list
      // the user confirms against must already be on screen.
      let outputAtRetire = "";
      onRetireDocker = () => {
        outputAtRetire = printedOutput();
      };

      process.argv = ["bun", "cadet", "uninstall", "--yes"];
      await uninstall();

      expect(retireDockerCalls).toEqual(["docker-assistant"]);
      expect(outputAtRetire).toContain("It will permanently delete:");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("will be retired as part of this uninstall"),
      );

      rmSync(root, { recursive: true, force: true });
    });
  });

  test("--yes deletes the environment's XDG locations and leaves the source checkout alone", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();

      // Pre-create every target the command should delete, using the SAME
      // path helpers so the test stays honest about what they resolve to.
      const stateDir = resolveDataDir();
      mkdirSync(join(stateDir, "assistants", "some-assistant"), {
        recursive: true,
      });
      mkdirSync(join(stateDir, "retired"), { recursive: true });
      const configDir = resolveConfigDir();
      mkdirSync(configDir, { recursive: true });
      const logDir = resolveLogDir();
      mkdirSync(logDir, { recursive: true });
      const historyPath = getInputHistoryPath();
      mkdirSync(dirname(historyPath), { recursive: true });
      writeFileSync(historyPath, "history");

      process.argv = ["bun", "cadet", "uninstall", "--yes"];
      await uninstall();

      expect(existsSync(stateDir)).toBe(false);
      expect(existsSync(configDir)).toBe(false);
      expect(existsSync(logDir)).toBe(false);
      expect(existsSync(historyPath)).toBe(false);

      // The list shows the shared state DIR (never the input-history FILE
      // alone) and never names a nested path twice — the log dir goes with
      // its parent's recursive delete.
      const out = printedOutput();
      expect(out).toContain(
        `  - ${getSharedStateDir()}  — shared state, including the terminal input history`,
      );
      expect(out).not.toContain(logDir);
      expect(out).not.toContain(historyPath);
      expect(out).not.toContain("It will then remove the Cadet executable");

      // Running under bun from a git checkout: self-removal must print the
      // note and delete NOTHING outside the XDG targets.
      expect(printedOutput()).toContain("source checkout");
      expect(existsSync(process.execPath)).toBe(true);

      rmSync(root, { recursive: true, force: true });
    });
  });

  test("--yes lists and removes the Cadet executable itself", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();
      const configDir = resolveConfigDir();
      mkdirSync(configDir, { recursive: true });

      // A compiled-binary install: process.execPath IS the install, so the
      // uninstall list must name it alongside the data dirs.
      const fakeBinDir = join(root, "bin");
      mkdirSync(fakeBinDir, { recursive: true });
      const fakeBin = join(fakeBinDir, "cadet");
      writeFileSync(fakeBin, "#!/bin/sh\n");

      const realExecPath = process.execPath;
      process.execPath = fakeBin;
      try {
        process.argv = ["bun", "cadet", "uninstall", "--yes"];
        await uninstall();
      } finally {
        process.execPath = realExecPath;
      }

      expect(printedOutput()).toContain(
        `  - ${fakeBin}  — the Cadet executable`,
      );
      expect(existsSync(fakeBin)).toBe(false);

      rmSync(root, { recursive: true, force: true });
    });
  });
});
