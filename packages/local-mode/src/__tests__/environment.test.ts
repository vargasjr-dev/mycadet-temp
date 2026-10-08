import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultEnvironmentFilePath,
  defaultEnvironmentFilePaths,
  readDefaultEnvironment,
  resolveEnvironmentName,
} from "../environment";
import {
  guardianTokenPath,
  resolveConfigDir,
  resolveInstanceDir,
  resolveLockfilePaths,
  resolveLogDir,
  resolveRuntimeDir,
} from "../config";

let configHome: string;

/** Write the persisted default-environment file under the temp config home. */
function persistDefault(name: string): void {
  const file = path.join(configHome, "cadet", "environment");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, name + "\n", "utf-8");
}

beforeEach(() => {
  configHome = mkdtempSync(path.join(os.tmpdir(), "cadet-env-"));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

describe("defaultEnvironmentFilePath", () => {
  test("honors XDG_CONFIG_HOME", () => {
    expect(defaultEnvironmentFilePath({ XDG_CONFIG_HOME: configHome })).toBe(
      path.join(configHome, "cadet", "environment"),
    );
  });

  test("falls back to ~/.config", () => {
    expect(defaultEnvironmentFilePath({})).toBe(
      path.join(os.homedir(), ".config", "cadet", "environment"),
    );
  });
});

describe("readDefaultEnvironment", () => {
  test("returns undefined when no file exists", () => {
    expect(
      readDefaultEnvironment({ XDG_CONFIG_HOME: configHome }),
    ).toBeUndefined();
  });

  test("returns the trimmed persisted name", () => {
    persistDefault("dev");
    expect(readDefaultEnvironment({ XDG_CONFIG_HOME: configHome })).toBe("dev");
  });

  test("treats an empty file as no default", () => {
    const file = path.join(configHome, "cadet", "environment");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "  \n", "utf-8");
    expect(
      readDefaultEnvironment({ XDG_CONFIG_HOME: configHome }),
    ).toBeUndefined();
  });
});

describe("resolveEnvironmentName", () => {
  test("prefers CADET_ENVIRONMENT over the persisted default", () => {
    persistDefault("dev");
    expect(
      resolveEnvironmentName({
        XDG_CONFIG_HOME: configHome,
        CADET_ENVIRONMENT: "staging",
      }),
    ).toBe("staging");
  });

  test("falls back to the persisted default when the env var is unset", () => {
    persistDefault("dev");
    expect(resolveEnvironmentName({ XDG_CONFIG_HOME: configHome })).toBe("dev");
  });

  test("falls back to production when neither is set", () => {
    expect(resolveEnvironmentName({ XDG_CONFIG_HOME: configHome })).toBe(
      "production",
    );
  });
});

describe("path resolvers honor the persisted default", () => {
  test("resolveLockfilePaths points at the persisted environment", () => {
    persistDefault("dev");
    const env = { XDG_CONFIG_HOME: configHome };
    expect(resolveLockfilePaths(env)).toEqual([
      path.join(configHome, "cadet-dev", "lockfile.json"),
    ]);
  });

  test("resolveConfigDir points at the persisted environment", () => {
    persistDefault("dev");
    expect(resolveConfigDir({ XDG_CONFIG_HOME: configHome })).toBe(
      path.join(configHome, "cadet-dev"),
    );
  });

  test("CADET_ENVIRONMENT still wins for path resolution", () => {
    persistDefault("dev");
    const env = {
      XDG_CONFIG_HOME: configHome,
      CADET_ENVIRONMENT: "production",
    };
    expect(resolveLockfilePaths(env)).toEqual([
      path.join(configHome, "cadet", "lockfile.json"),
      path.join(os.homedir(), ".cadet.lock.json"),
      path.join(os.homedir(), ".cadet.lockfile.json"),
    ]);
  });
});

describe("Windows path resolution", () => {
  const options = {
    platform: "win32" as const,
    homeDir: "C:\\Users\\Example",
  };
  const env = {
    APPDATA: "C:\\Users\\Example\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
    XDG_CONFIG_HOME: "D:\\LegacyConfig",
    CADET_ENVIRONMENT: "dev",
  };

  test("uses AppData with XDG read compatibility", () => {
    const paths = [
      [
        defaultEnvironmentFilePath(env, options),
        "AppData\\Roaming\\cadet\\environment",
      ],
      [resolveConfigDir(env, options), "AppData\\Roaming\\cadet-dev"],
      [resolveRuntimeDir(env, options), "AppData\\Local\\cadet-dev"],
      [resolveLogDir(env, options), "AppData\\Local\\cadet-dev\\logs"],
      [
        resolveInstanceDir(env, "assistant-123", options),
        "AppData\\Local\\cadet-dev\\assistants\\assistant-123",
      ],
    ];
    for (const [actual, suffix] of paths) {
      expect(actual).toBe(`C:\\Users\\Example\\${suffix}`);
    }
    expect(resolveLockfilePaths(env, options)).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\cadet-dev\\lockfile.json",
      "D:\\LegacyConfig\\cadet-dev\\lockfile.json",
    ]);
  });

  test("falls back to conventional AppData directories", () => {
    const productionEnv = { CADET_ENVIRONMENT: "production" };
    expect(resolveLockfilePaths(productionEnv, options)).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\cadet\\lockfile.json",
      "C:\\Users\\Example\\.cadet.lock.json",
      "C:\\Users\\Example\\.cadet.lockfile.json",
    ]);
    expect(defaultEnvironmentFilePaths(env, options)).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\cadet\\environment",
      "D:\\LegacyConfig\\cadet\\environment",
    ]);
  });

  test("rejects unsafe path segments", () => {
    for (const assistantId of ["../other", "nested/other", "CON", "bad\\id"]) {
      expect(() => resolveInstanceDir(env, assistantId, options)).toThrow(
        "Invalid assistant ID",
      );
      expect(() =>
        guardianTokenPath("C:\\Cadet", assistantId, options),
      ).toThrow("Invalid assistant ID");
    }
  });
});
