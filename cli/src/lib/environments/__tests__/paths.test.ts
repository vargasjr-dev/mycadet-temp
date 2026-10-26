import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const TEST_HOME = "/test/home";

// Mock homedir() so the helpers return predictable paths regardless of who
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
const {
  getConfigDir,
  getConfigDirs,
  getDefaultPorts,
  getInputHistoryPath,
  getLockfilePath,
  getLockfilePaths,
  getMultiInstanceDir,
  getSharedStateDir,
} = await import("../paths.js");
const { resolveConfigDir, resolveEnvironmentName } = await import(
  "@mycadet/local-mode"
);
type EnvironmentDefinition =
  import("@mycadet/environments").EnvironmentDefinition;

const dev: EnvironmentDefinition = {
  name: "dev",
  cloudUrl: "https://dev-cloud.mycadet.ai",
  webUrl: "https://dev.mycadet.ai",
};

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

  describe("getConfigDir", () => {
    test("agrees with local-mode's ambient resolver", () => {
      // The helpers are thin aliases now; the property that matters is that
      // the CLI's own resolver and the shared path layer name the same dir.
      process.env.CADET_ENVIRONMENT = "dev";
      expect(getConfigDir()).toBe(resolveConfigDir());
    });

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
        expect(getConfigDirs()).toEqual([
          "C:\\AppData\\cadet-dev",
          "D:\\Legacy\\cadet-dev",
        ]);
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });

    test("production returns ~/.config/cadet/", () => {
      expect(getConfigDir()).toBe(join(TEST_HOME, ".config", "cadet"));
    });

    test("dev returns ~/.config/cadet-dev/", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(getConfigDir()).toBe(join(TEST_HOME, ".config", "cadet-dev"));
    });

    test("respects XDG_CONFIG_HOME", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      process.env.XDG_CONFIG_HOME = "/custom/config";
      expect(getConfigDir()).toBe("/custom/config/cadet-dev");
      process.env.CADET_ENVIRONMENT = "production";
      expect(getConfigDir()).toBe("/custom/config/cadet");
    });

    test("dev resolves even against a stale persisted default", () => {
      // The regression behind #562: a released -dev. install must not read
      // production's dirs just because an old CLI persisted a default.
      expect(resolveEnvironmentName()).toBe("production");
      process.env.CADET_ENVIRONMENT = "dev";
      expect(getConfigDir()).toBe(join(TEST_HOME, ".config", "cadet-dev"));
    });
  });

  describe("getLockfilePath", () => {
    test("production returns the config-dir lockfile.json", () => {
      process.env.CADET_ENVIRONMENT = "production";
      expect(getLockfilePath()).toBe(
        join(TEST_HOME, ".config", "cadet", "lockfile.json"),
      );
    });

    test("dev returns ~/.config/cadet-dev/lockfile.json", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(getLockfilePath()).toBe(
        join(TEST_HOME, ".config", "cadet-dev", "lockfile.json"),
      );
    });
  });

  describe("getLockfilePaths", () => {
    test("returns a single canonical path outside Windows", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(getLockfilePaths()).toEqual([
        join(TEST_HOME, ".config", "cadet-dev", "lockfile.json"),
      ]);
    });

    test("Windows non-prod keeps the XDG legacy read", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", {
          ...descriptor,
          value: "win32",
        });
        process.env.APPDATA = "C:\\AppData";
        process.env.XDG_CONFIG_HOME = "D:\\Legacy";
        process.env.CADET_ENVIRONMENT = "dev";
        expect(getLockfilePaths()).toEqual([
          "C:\\AppData\\cadet-dev\\lockfile.json",
          "D:\\Legacy\\cadet-dev\\lockfile.json",
        ]);
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });

    test("Windows production reads only the canonical path", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", {
          ...descriptor,
          value: "win32",
        });
        process.env.APPDATA = "C:\\AppData";
        process.env.XDG_CONFIG_HOME = "D:\\Legacy";
        process.env.CADET_ENVIRONMENT = "production";
        expect(getLockfilePaths()).toEqual([
          "C:\\AppData\\cadet\\lockfile.json",
        ]);
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });
  });

  describe("getMultiInstanceDir", () => {
    test("dev uses ~/.local/share/cadet-dev/assistants/", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      expect(getMultiInstanceDir()).toBe(
        join(TEST_HOME, ".local", "share", "cadet-dev", "assistants"),
      );
    });

    test("respects XDG_DATA_HOME", () => {
      process.env.CADET_ENVIRONMENT = "dev";
      process.env.XDG_DATA_HOME = "/custom/data";
      expect(getMultiInstanceDir()).toBe(
        "/custom/data/cadet-dev/assistants",
      );
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
      const prod: EnvironmentDefinition = {
        name: "production",
        cloudUrl: "https://cloud.mycadet.ai",
        webUrl: "https://mycadet.ai",
      };
      expect(getDefaultPorts(prod)).toEqual({
        daemon: 7821,
        gateway: 7830,
        qdrant: 6333,
        ces: 8090,
        outboundProxy: 8080,
        tcp: 8765,
      });
    });

    test("merges env.portsOverride on top of defaults", () => {
      const customized: EnvironmentDefinition = {
        ...dev,
        portsOverride: { daemon: 7831 },
      };
      expect(getDefaultPorts(customized).daemon).toBe(7831);
      expect(getDefaultPorts(customized).gateway).toBe(7830);
    });
  });
});
