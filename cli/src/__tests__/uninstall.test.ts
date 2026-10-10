import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { uninstall } from "../commands/uninstall.js";
import {
  getConfigDirs,
  getInputHistoryPath,
  getLogDir,
  getStateDir,
} from "../lib/environments/paths.js";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

// The command reads its argv at call time.
const ORIGINAL_ARGV = process.argv;

// Every XDG location the command touches MUST be redirected: the homedir
// fallback would otherwise point at the real user's data dirs.
function redirectXdg(): string {
  const root = mkdtempSync(join(tmpdir(), "cadet-uninstall-"));
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.CADET_ENVIRONMENT = "production";
  process.env.CADET_LOCKFILE_DIR = join(root, "lockdir");
  mkdirSync(process.env.CADET_LOCKFILE_DIR, { recursive: true });
  return root;
}

const RESTORED_ENV_KEYS = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "CADET_ENVIRONMENT",
  "CADET_LOCKFILE_DIR",
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

function makeEntry(assistantId: string): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: "http://127.0.0.1:7801",
    cloud: "local",
    resources: {
      instanceDir: join(tmpdir(), "cadet-uninstall-instance"),
      daemonPort: 7801,
      gatewayPort: 7831,
      qdrantPort: 6334,
      cesPort: 7790,
    },
  };
}

describe("cadet uninstall", () => {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  afterAll(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("warns and retires remaining assistants, then proceeds to the confirm gate", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();
      // A remaining assistant is retired — with its data deleted — as part
      // of the uninstall (v0.0.10 run feedback: the old hard refusal just
      // blocked the uninstall; the fs sweep deletes the archives anyway).
      writeFileSync(
        join(process.env.CADET_LOCKFILE_DIR!, "lockfile.json"),
        JSON.stringify({ assistants: [makeEntry("test-assistant")] }) + "\n",
      );

      const exitMock = spyOn(process, "exit");
      exitMock.mockImplementation((code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      });
      try {
        // Non-interactive without --yes, the CONFIRM gate is what refuses —
        // not an assistant guard.
        await expect(uninstall()).rejects.toThrow("process.exit:1");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("1 assistant(s) still exist"),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("will be retired now"),
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
      exitMock.mockImplementation((code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      });
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

  test("--yes deletes the environment's XDG locations and leaves the source checkout alone", async () => {
    await withRestoredEnv(async () => {
      const root = redirectXdg();
      const env = getCurrentEnvironment();

      // Pre-create every target the command should delete, using the SAME
      // path helpers so the test stays honest about what they resolve to.
      const stateDir = getStateDir(env);
      mkdirSync(join(stateDir, "assistants", "some-assistant"), {
        recursive: true,
      });
      mkdirSync(join(stateDir, "retired"), { recursive: true });
      const configDir = getConfigDirs(env)[0]!;
      mkdirSync(configDir, { recursive: true });
      const logDir = getLogDir(env);
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

      // Running under bun from a git checkout: self-removal must print the
      // note and delete NOTHING outside the XDG targets.
      const note = logSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(note).toContain("source checkout");
      expect(existsSync(process.execPath)).toBe(true);

      rmSync(root, { recursive: true, force: true });
    });
  });
});
