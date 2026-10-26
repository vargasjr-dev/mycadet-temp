import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultEnvironmentFilePath,
  defaultEnvironmentFilePaths,
  environmentFromVersion,
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

/**
 * The env keys these tests steer. resolveEnvironmentName reads `process.env`
 * directly (it has no parameters to inject through), and readDefaultEnvironment
 * under it reads the config home from the same source — so every test that
 * exercises resolution saves and clears these first, then restores them.
 */
const RESOLUTION_ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "CADET_ENVIRONMENT",
] as const;

const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

/** Write the persisted default-environment file under the temp config home. */
function persistDefault(name: string): void {
  const file = path.join(configHome, "cadet", "environment");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, name + "\n", "utf-8");
}

beforeEach(() => {
  configHome = mkdtempSync(path.join(os.tmpdir(), "cadet-env-"));
  for (const key of RESOLUTION_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    setEnv(key, undefined);
  }
  // Default the config home to the temp dir so the persisted-default read
  // never consults the real ~/.config during a test.
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    setEnv(key, value);
  }
  savedEnv.clear();
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

describe("environmentFromVersion", () => {
  test("maps the release channels like the CLI resolver does", () => {
    expect(environmentFromVersion("0.12.6-local.42")).toBe("local");
    expect(environmentFromVersion("0.12.6-dev.202610081023.3a27b77")).toBe(
      "dev",
    );
    expect(environmentFromVersion("0.6.0-staging.3")).toBe("staging");
  });

  test("reads a plain version as no version signal", () => {
    // A source checkout's package.json version must not pin anything —
    // the remaining resolution steps decide.
    expect(environmentFromVersion("0.13.0")).toBeUndefined();
  });
});

describe("resolveEnvironmentName", () => {
  test("prefers CADET_ENVIRONMENT over the version and persisted default", () => {
    persistDefault("dev");
    process.env.CADET_ENVIRONMENT = "staging";
    expect(resolveEnvironmentName()).toBe("staging");
  });

  test("resolves the release channel from the CLI package version", () => {
    // In this workspace the resolvable CLI package is the source checkout
    // (plain "0.13.0"), which pins nothing — the version step here is
    // exercised through environmentFromVersion above, and the released
    // `-dev.` stamp resolves through the same mapping. A plain version
    // falls through to the persisted default.
    persistDefault("dev");
    expect(resolveEnvironmentName()).toBe("dev");
  });

  test("falls back to production when nothing pins an environment", () => {
    expect(resolveEnvironmentName()).toBe("production");
  });
});

describe("path resolvers honor the persisted default", () => {
  test("resolveLockfilePaths points at the persisted environment", () => {
    persistDefault("dev");
    expect(resolveLockfilePaths(process.env)).toEqual([
      path.join(configHome, "cadet-dev", "lockfile.json"),
    ]);
  });

  test("resolveConfigDir points at the persisted environment", () => {
    persistDefault("dev");
    expect(resolveConfigDir(process.env)).toBe(
      path.join(configHome, "cadet-dev"),
    );
  });

  test("CADET_ENVIRONMENT still wins for path resolution", () => {
    persistDefault("dev");
    process.env.CADET_ENVIRONMENT = "production";
    expect(resolveLockfilePaths(process.env)).toEqual([
      path.join(configHome, "cadet", "lockfile.json"),
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
    process.env.CADET_ENVIRONMENT = "dev";
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
    process.env.CADET_ENVIRONMENT = "production";
    expect(
      resolveLockfilePaths(
        { APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA },
        options,
      ),
    ).toEqual(["C:\\Users\\Example\\AppData\\Roaming\\cadet\\lockfile.json"]);
    expect(defaultEnvironmentFilePaths(env, options)).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\cadet\\environment",
      "D:\\LegacyConfig\\cadet\\environment",
    ]);
  });

  test("rejects unsafe path segments", () => {
    process.env.CADET_ENVIRONMENT = "dev";
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
