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
 * The env keys these tests steer. Every resolver reads `process.env`
 * directly (they have no parameters to inject through), so each test saves
 * and clears these first, then restores them.
 */
const RESOLUTION_ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
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
    expect(defaultEnvironmentFilePath()).toBe(
      path.join(configHome, "cadet", "environment"),
    );
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    expect(defaultEnvironmentFilePath()).toBe(
      path.join(os.homedir(), ".config", "cadet", "environment"),
    );
  });
});

describe("readDefaultEnvironment", () => {
  test("returns undefined when no file exists", () => {
    expect(readDefaultEnvironment()).toBeUndefined();
  });

  test("returns the trimmed persisted name", () => {
    persistDefault("dev");
    expect(readDefaultEnvironment()).toBe("dev");
  });

  test("treats an empty file as no default", () => {
    const file = path.join(configHome, "cadet", "environment");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "  \n", "utf-8");
    expect(readDefaultEnvironment()).toBeUndefined();
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
    // The workspace package version (0.0.1) must not pin anything — the
    // remaining resolution steps decide.
    expect(environmentFromVersion("0.0.1")).toBeUndefined();
  });
});

describe("resolveEnvironmentName", () => {
  test("prefers CADET_ENVIRONMENT over the version and persisted default", () => {
    persistDefault("dev");
    process.env.CADET_ENVIRONMENT = "staging";
    expect(resolveEnvironmentName()).toBe("staging");
  });

  test("falls back to the persisted default when the env var is unset", () => {
    // In this workspace the package version is the plain checkout 0.0.1,
    // which pins nothing — the persisted default decides.
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
    expect(resolveLockfilePaths()).toEqual([
      path.join(configHome, "cadet-dev", "lockfile.json"),
    ]);
  });

  test("resolveConfigDir points at the persisted environment", () => {
    persistDefault("dev");
    expect(resolveConfigDir()).toBe(path.join(configHome, "cadet-dev"));
  });

  test("CADET_ENVIRONMENT still wins for path resolution", () => {
    persistDefault("dev");
    process.env.CADET_ENVIRONMENT = "production";
    expect(resolveLockfilePaths()).toEqual([
      path.join(configHome, "cadet", "lockfile.json"),
    ]);
  });
});

describe("Windows path resolution", () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.APPDATA = "C:\\Users\\Example\\AppData\\Roaming";
    process.env.LOCALAPPDATA = "C:\\Users\\Example\\AppData\\Local";
    process.env.XDG_CONFIG_HOME = "D:\\LegacyConfig";
    process.env.CADET_ENVIRONMENT = "dev";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  test("uses AppData with XDG read compatibility", () => {
    const paths = [
      [defaultEnvironmentFilePath(), "AppData\\Roaming\\cadet\\environment"],
      [resolveConfigDir(), "AppData\\Roaming\\cadet-dev"],
      [resolveRuntimeDir(), "AppData\\Local\\cadet-dev"],
      [resolveLogDir(), "AppData\\Local\\cadet-dev\\logs"],
      [
        resolveInstanceDir("assistant-123"),
        "AppData\\Local\\cadet-dev\\assistants\\assistant-123",
      ],
    ];
    for (const [actual, suffix] of paths) {
      expect(actual).toBe(`C:\\Users\\Example\\${suffix}`);
    }
    expect(resolveLockfilePaths()).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\cadet-dev\\lockfile.json",
      "D:\\LegacyConfig\\cadet-dev\\lockfile.json",
    ]);
  });

  test("falls back to conventional AppData directories", () => {
    process.env.CADET_ENVIRONMENT = "production";
    expect(resolveLockfilePaths()).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\cadet\\lockfile.json",
    ]);
    expect(defaultEnvironmentFilePaths()).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\cadet\\environment",
      "D:\\LegacyConfig\\cadet\\environment",
    ]);
  });

  test("rejects unsafe path segments", () => {
    for (const assistantId of ["../other", "nested/other", "CON", "bad\\id"]) {
      expect(() => resolveInstanceDir(assistantId)).toThrow(
        "Invalid assistant ID",
      );
      expect(() => guardianTokenPath("C:\\Cadet", assistantId)).toThrow(
        "Invalid assistant ID",
      );
    }
  });
});
