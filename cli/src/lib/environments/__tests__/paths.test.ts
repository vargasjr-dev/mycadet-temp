import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { join } from "path";

const TEST_HOME = "/test/home";

// Mock homedir() so the resolvers return predictable paths regardless of who
// is running the test. `os.homedir()` is read once per process on Bun/Node
// and does not reflect later $HOME changes, so setting process.env.HOME at
// test time does not work — module mocking is the recommended pattern.
const realOs = await import("node:os");
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => TEST_HOME,
}));
mock.module("os", () => ({
  ...realOs,
  homedir: () => TEST_HOME,
}));

// Restore the real `os` module once this file finishes so the `homedir()`
// override does not leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("node:os", () => realOs);
  mock.module("os", () => realOs);
});

// Imports that depend on the mocked `os` module must come after the
// mock.module() calls above.
const { getDefaultPorts, getInputHistoryPath, getSharedStateDir } =
  await import("../paths.js");
const {
  resolveAssistantsDir,
  resolveConfigDir,
  resolveEnvironmentName,
  resolveLockfilePath,
} = await import("@mycadet/local-mode");
const XDG_ENV_VARS = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "CADET_ENVIRONMENT",
] as const;

describe("path helpers", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of XDG_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("resolveConfigDir", () => {
    test("Windows keeps XDG config as a legacy read location", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", {
          ...descriptor,
          value: "win32",
        });
        process.env.APPDATA = "C:\\AppData";
        process.env.XDG_CONFIG_HOME = "D:\\Legacy";
        process.env.CADET_ENVIRONMENT = "dev";
        expect(resolveConfigDir()).toBe("C:\\AppData\\cadet-dev");
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });

    test("production returns ~/.config/cadet/", () => {
      process.env.CADET_ENVIRONMENT = "production";
      expect(resolveConfigDir()).toBe(join(TEST_HOME, ".config", "cadet"));
    });

    test("dev returns ~/.config/cadet-dev/", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(resolveConfigDir()).toBe(join(TEST_HOME, ".config", "cadet-dev"));
    });

    test("respects XDG_CONFIG_HOME", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      process.env.XDG_CONFIG_HOME = "/custom/config";
      expect(resolveConfigDir()).toBe("/custom/config/cadet-dev");
      process.env.CADET_ENVIRONMENT = "production";
      expect(resolveConfigDir()).toBe("/custom/config/cadet");
    });

    test("dev resolves even against a stale persisted default", () => {
      // The regression behind #562: a released -dev. install must not read
      // production's dirs just because an old CLI persisted a default.
      process.env.CADET_ENVIRONMENT = "production";
      expect(resolveEnvironmentName()).toBe("production");
      process.env.CADET_ENVIRONMENT = "dev";
      expect(resolveConfigDir()).toBe(join(TEST_HOME, ".config", "cadet-dev"));
    });
  });

  describe("resolveLockfilePath", () => {
    test("production returns the config-dir lockfile.json", () => {
      process.env.CADET_ENVIRONMENT = "production";
      expect(resolveLockfilePath()).toBe(
        join(TEST_HOME, ".config", "cadet", "lockfile.json"),
      );
    });

    test("dev returns ~/.config/cadet-dev/lockfile.json", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(resolveLockfilePath()).toBe(
        join(TEST_HOME, ".config", "cadet-dev", "lockfile.json"),
      );
    });

    test("Windows reads the AppData config dir only", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", {
          ...descriptor,
          value: "win32",
        });
        process.env.APPDATA = "C:\\AppData";
        process.env.XDG_CONFIG_HOME = "D:\\Legacy";
        process.env.CADET_ENVIRONMENT = "dev";
        expect(resolveLockfilePath()).toBe(
          "C:\\AppData\\cadet-dev\\lockfile.json",
        );
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });
  });

  describe("resolveAssistantsDir", () => {
    test("dev uses ~/.local/share/cadet-dev/assistants/", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(resolveAssistantsDir()).toBe(
        join(TEST_HOME, ".local", "share", "cadet-dev", "assistants"),
      );
    });

    test("respects XDG_DATA_HOME", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      process.env.XDG_DATA_HOME = "/custom/data";
      expect(resolveAssistantsDir()).toBe("/custom/data/cadet-dev/assistants");
    });
  });

  describe("getSharedStateDir", () => {
    test("is not environment-scoped: ~/.local/state/cadet for every env", () => {
      expect(getSharedStateDir()).toBe(
        join(TEST_HOME, ".local", "state", "cadet"),
      );
      process.env.CADET_ENVIRONMENT = "production";
      expect(getSharedStateDir()).toBe(
        join(TEST_HOME, ".local", "state", "cadet"),
      );
    });

    test("respects XDG_STATE_HOME", () => {
      process.env.XDG_STATE_HOME = "/custom/state";
      expect(getSharedStateDir()).toBe("/custom/state/cadet");
    });

    test("holds the shared terminal input history file", () => {
      expect(getInputHistoryPath()).toBe(
        join(TEST_HOME, ".local", "state", "cadet", "input-history"),
      );
    });
  });

  describe("getDefaultPorts", () => {
    test("returns production defaults for production", () => {
      process.env.CADET_ENVIRONMENT = "production";
      expect(getDefaultPorts()).toEqual({
        daemon: 7821,
        gateway: 7830,
        qdrant: 6333,
        ces: 8090,
        outboundProxy: 8080,
        tcp: 8765,
      });
    });

    test("merges the environment's portsOverride on top of defaults", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(getDefaultPorts().daemon).toBe(18000);
      expect(getDefaultPorts().gateway).toBe(18100);
    });
  });
});
