import { describe, expect, test } from "bun:test";

import {
  resolveAssistantsDir,
  resolveConfigDir,
  resolveConfigDirPaths,
  resolveInstanceDir,
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
  resolveLogDir,
  resolveRuntimeDir,
  guardianTokenPath,
} from "../config";

const PROD_ENV = { CADET_ENVIRONMENT: "production" } as Record<
  string,
  string | undefined
>;
const DEV_ENV = { CADET_ENVIRONMENT: "dev" } as Record<
  string,
  string | undefined
>;

describe("resolveConfigDirPaths", () => {
  test("prefers an explicit configDirOverride over everything", () => {
    const dirs = resolveConfigDirPaths(PROD_ENV, { configDirOverride: "/x" });
    expect(dirs).toEqual(["/x"]);
  });

  test("uses XDG_CONFIG_HOME when set", () => {
    const dirs = resolveConfigDirPaths(
      { XDG_CONFIG_HOME: "/xdg" },
      { environmentName: "production" },
    );
    expect(dirs).toEqual(["/xdg/cadet"]);
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const dirs = resolveConfigDirPaths(
      {},
      { homeDir: "/home/u", environmentName: "production" },
    );
    expect(dirs).toEqual(["/home/u/.config/cadet"]);
  });

  test("names non-production environment directories cadet-<env>", () => {
    const dirs = resolveConfigDirPaths({}, {
      homeDir: "/home/u",
      environmentName: "dev",
    });
    expect(dirs).toEqual(["/home/u/.config/cadet-dev"]);
  });
});

describe("resolveConfigDir", () => {
  test("is the first of resolveConfigDirPaths", () => {
    expect(
      resolveConfigDir(PROD_ENV, { configDirOverride: "/only" }),
    ).toBe("/only");
  });
});

describe("resolveLockfilePaths", () => {
  test("production on posix reads the home dotfiles", () => {
    const paths = resolveLockfilePaths(PROD_ENV, {
      homeDir: "/home/u",
      platform: "linux",
    });
    expect(paths).toEqual([
      "/home/u/.cadet.lock.json",
      "/home/u/.cadet.lockfile.json",
    ]);
  });

  test("non-production on posix reads the config dir's lockfile.json", () => {
    const paths = resolveLockfilePaths(DEV_ENV, {
      homeDir: "/home/u",
      platform: "linux",
    });
    expect(paths).toEqual(["/home/u/.config/cadet-dev/lockfile.json"]);
  });

  test("CADET_LOCKFILE_DIR wins over the config dir on posix", () => {
    const paths = resolveLockfilePaths(
      { ...DEV_ENV, CADET_LOCKFILE_DIR: "/custom" },
      { homeDir: "/home/u", platform: "linux" },
    );
    expect(paths).toEqual(["/custom/lockfile.json"]);
  });

  test("lockfileDirOverride wins over the env var", () => {
    const paths = resolveLockfilePaths(
      { ...DEV_ENV, CADET_LOCKFILE_DIR: "/from-env" },
      {
        homeDir: "/home/u",
        platform: "linux",
        lockfileDirOverride: "/from-option",
      },
    );
    expect(paths).toEqual(["/from-option/lockfile.json"]);
  });

  test("win32 production lists the canonical file then the legacy home dotfiles", () => {
    const paths = resolveLockfilePaths(PROD_ENV, {
      homeDir: "C:\\Users\\u",
      platform: "win32",
    });
    expect(paths).toEqual([
      "C:\\Users\\u\\AppData\\Roaming\\cadet\\lockfile.json",
      "C:\\Users\\u\\.cadet.lock.json",
      "C:\\Users\\u\\.cadet.lockfile.json",
    ]);
  });

  test("win32 production legacy dotfiles follow the lockfile override", () => {
    const paths = resolveLockfilePaths(PROD_ENV, {
      homeDir: "C:\\Users\\u",
      platform: "win32",
      lockfileDirOverride: "C:\\custom",
    });
    expect(paths).toEqual([
      "C:\\custom\\lockfile.json",
      "C:\\custom\\.cadet.lock.json",
      "C:\\custom\\.cadet.lockfile.json",
    ]);
  });

  test("win32 production drops legacy candidates equal to the canonical file", () => {
    const paths = resolveLockfilePaths(PROD_ENV, {
      homeDir: "C:\\Users\\u",
      platform: "win32",
      lockfileDirOverride: "C:\\Users\\u\\AppData\\Roaming\\cadet",
    });
    // Canonical + the two dotfiles all in one dir — no lockfile.json twice.
    expect(paths).toEqual([
      "C:\\Users\\u\\AppData\\Roaming\\cadet\\lockfile.json",
      "C:\\Users\\u\\AppData\\Roaming\\cadet\\.cadet.lock.json",
      "C:\\Users\\u\\AppData\\Roaming\\cadet\\.cadet.lockfile.json",
    ]);
  });

  test("win32 non-production pairs the canonical file with the legacy XDG config path", () => {
    const paths = resolveLockfilePaths(DEV_ENV, {
      homeDir: "C:\\Users\\u",
      platform: "win32",
    });
    expect(paths).toEqual([
      "C:\\Users\\u\\AppData\\Roaming\\cadet-dev\\lockfile.json",
      "C:\\Users\\u\\.config\\cadet-dev\\lockfile.json",
    ]);
  });
});

describe("resolveLocalConfigFromEnv", () => {
  test("falls back to the production seed URLs with no overrides", () => {
    const config = resolveLocalConfigFromEnv({}, { environmentName: "production" });
    expect(typeof config.webUrl).toBe("string");
    expect(config.webUrl.length).toBeGreaterThan(0);
    expect(typeof config.platformUrl).toBe("string");
    expect(config.platformUrl.length).toBeGreaterThan(0);
  });

  test("CADET_WEB_URL and CADET_PLATFORM_URL override the seed", () => {
    const config = resolveLocalConfigFromEnv({
      CADET_WEB_URL: "http://web.local",
      CADET_PLATFORM_URL: "http://platform.local",
    });
    expect(config.webUrl).toBe("http://web.local");
    expect(config.platformUrl).toBe("http://platform.local");
  });

  test("threads the environment into the lockfile + config dirs", () => {
    const config = resolveLocalConfigFromEnv(
      { ...DEV_ENV, XDG_CONFIG_HOME: "/xdg" },
      { platform: "linux" },
    );
    expect(config.configDir).toBe("/xdg/cadet-dev");
    expect(config.lockfilePaths).toEqual(["/xdg/cadet-dev/lockfile.json"]);
  });
});

describe("resolveRuntimeDir / resolveLogDir / resolveAssistantsDir", () => {
  test("runtime dir lives under the data home, named per environment", () => {
    const dir = resolveRuntimeDir(DEV_ENV, {
      platform: "linux",
      homeDir: "/home/u",
    });
    expect(dir).toBe("/home/u/.local/share/cadet-dev");
  });

  test("log dir sits under the config dir on posix", () => {
    const dir = resolveLogDir(DEV_ENV, {
      platform: "linux",
      homeDir: "/home/u",
    });
    expect(dir).toBe("/home/u/.config/cadet-dev/logs");
  });

  test("log dir sits under the data dir on windows", () => {
    const dir = resolveLogDir(DEV_ENV, {
      platform: "win32",
      homeDir: "C:\\Users\\u",
    });
    expect(dir?.endsWith("cadet-dev\\logs")).toBe(true);
    expect(dir?.includes("Roaming")).toBe(false);
  });

  test("assistants dir nests under the runtime dir", () => {
    const dir = resolveAssistantsDir(DEV_ENV, {
      platform: "linux",
      homeDir: "/home/u",
    });
    expect(dir).toBe("/home/u/.local/share/cadet-dev/assistants");
  });
});

describe("resolveInstanceDir", () => {
  test("nests the assistant id under the assistants dir", () => {
    const dir = resolveInstanceDir(DEV_ENV, "asst-42", {
      platform: "linux",
      homeDir: "/home/u",
    });
    expect(dir).toBe("/home/u/.local/share/cadet-dev/assistants/asst-42");
  });

  test("rejects path-traversal assistant ids", () => {
    expect(() =>
      resolveInstanceDir(DEV_ENV, "../escape", { homeDir: "/home/u" }),
    ).toThrow("Invalid assistant ID");
  });
});

describe("guardianTokenPath", () => {
  test("joins configDir/assistants/<id>/guardian-token.json", () => {
    expect(guardianTokenPath("/cfg", "asst-42")).toBe(
      "/cfg/assistants/asst-42/guardian-token.json",
    );
  });

  test("rejects an unsafe assistant id so readers and the CLI writer can't drift", () => {
    expect(() => guardianTokenPath("/cfg", "a/b")).toThrow("Invalid assistant ID");
  });
});
